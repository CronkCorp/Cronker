# Testing

Tests exercise Cronk from the outside, the way a User or Agent does: they call the HTTP API (or drive the web client) and assert on responses and on what later calls return. They never read tables, import internal modules or call private functions, so the inside can be refactored freely. Only the harness reaches in, and only for what starting Cronk takes: `createCronk` and the migrations that build its template database. Rules are not tested through lower-level unit seams.

## Seams

These are the seams from the milestone 1 spec (#1). Tests live only at them.

1. **HTTP API against a real, disposable Postgres** (primary). Cronk runs in-process with the clock under the test's control. Nearly every rule is tested here, live updates included, by reading a Workspace's event stream over HTTP. Lives in `test/api/`.
2. **The Runner interface with a fake Runner.** Every `startCronk()` installs a fake Runner (`test/harness/runner.ts`) as the Runner kind `fake`. It records each start and stop and can be told to refuse the next start (rate limits included) or to report a Run ended without finishing. Agents' own calls, such as `finish`, come through the API or MCP. Lives in `test/api/runs.test.ts`, `test/api/runs-gone-wrong.test.ts`, `test/api/delegation.test.ts`, `test/api/agent-work.test.ts` (what an Agent does inside its Run: edits, Reports and its last call) and `test/api/agents-creating-tickets.test.ts` (Sub-Tickets and Discovered Tickets an Agent files).
3. **The subscription Runner against a stand-in HTTP server** for the scheduled-task fire endpoint. Every `startCronk()` points Cronk at a stand-in (`test/harness/claude.ts`); the real service is never called. Lives in `test/api/subscription-runner.test.ts`, with one Playwright walk through the Runners page in `e2e/runners.spec.ts`.
4. **MCP** (thin): a real MCP client (the MCP SDK's) against the running server, for bearer tokens, OAuth and the mapping of tools onto the API. Lives in `test/mcp/`; the OAuth flow's rules (consent, codes, refresh, Client ID Metadata Documents) are tested at the API in `test/api/oauth.test.ts`, with one Playwright walk through the consent screen in `e2e/connect.spec.ts`. A test publishes a client's metadata document from its own local HTTP server: a Cronk on plain http, which only a local one may be, accepts plain http metadata document URLs.
5. **Sign in with GitHub against a stand-in OAuth server.** Every `startCronk()` points Cronk at a stand-in GitHub (`test/harness/github.ts`) for the manifest flow, OAuth sign-in and account lookups; the real GitHub is never called. Lives in `test/api/github.test.ts`, with one Playwright walk through it in `e2e/github.spec.ts`.
6. **Web UI smoke tests** (Playwright): a few walk the main path in a real browser. The web client holds no rules, so it gets no further tests. Lives in `e2e/`.

What a seam can't see, such as that only hashes of secrets are stored, is kept by code review rather than by tests reaching past the seam.

## The harness

`test/harness/` holds what every test starts from:

- **`startCronk()`** (`start-cronk.ts`) creates a disposable database, starts Cronk in-process listening on a free local port, and returns:
  - `url`: Cronk's address, which is also its configured public address, so the browser and `Origin` checks see the same thing.
  - `github`: the stand-in GitHub Cronk talks to (below).
  - `claude`: the stand-in claude.ai fire endpoint (`claude.ts`) the built-in `subscription` Runner fires scheduled tasks at. `claude.trigger(id, token)` adds a trigger it knows (others answer 404, a wrong token 401), `claude.rateLimitNext(retryAfter)` answers the next fire with 429, and `claude.fires` lists every fire with its trigger id, token, headers and body.
  - `runner`: the fake Runner (`runner.ts`). A User sets up a Runner of the kind `fake` (`POST /api/runners`) and points an Agent at it; `runner.starts` lists every start asked of it, `runner.stops` every stop, `runner.refuseNext(refusal)` refuses the next start, and `runner.endWithoutFinishing(runId)` reports a Run ended without finishing.
  - `checkForLostRuns()`: runs the check the server runs every minute, which makes lost the Runs nothing has named for their Workspace's lost-Run threshold. Move the clock first.
  - `resumePausedRunners()`: runs the other check the server runs every minute, which resumes the queues of rate-limited Runners whose pause has passed. Move the clock first.
  - `request(method, path, { body, cookie, origin, headers })`: a `fetch` against it. It sends no `Origin` unless asked, like a non-browser client.
  - `clock`: the test's clock (below).
  - `logs` and `setupCode()`: everything Cronk logged, and the setup code a fresh installation logs.
  - `command(...args)`: runs a server command (`server/command.ts`) in a child process against this Cronk's database, as an operator would, and returns its exit code, stdout and stderr.
  - `stop()`: closes Cronk and drops its database. Call it in `afterEach`.
- **Disposable Postgres per test** (`database.ts`). Each `startCronk()` copies a fresh database from a migrated template (`create database … template …`), so tests share nothing and none pays for migrations. The template's name carries a hash of `migrations/`, so changing a migration builds a new template on the next run.
- **The injectable clock** (`clock.ts`). Cronk reads the time only through its `Clock`. `TestClock` starts at a fixed instant and moves only on `clock.advance(ms)`; `days(n)` and `hours(n)` help. Use it for anything that expires.
- **The stand-in GitHub** (`github.ts`). A local HTTP server answering as GitHub does, redirects included, for creating a GitHub App from a manifest, authorizing it to sign in (OAuth) and looking up accounts. `github.account(login, email?)` adds an account GitHub knows of; `github.signedInAs` is the account the browser is signed in to GitHub as, who approves at once; `github.apps` lists the Apps created. Cronk starts with a random `CRONK_SECRET_KEY`, or none with `startCronk({ noSecretKey: true })`.
- **`openStream(cronk, cookie, workspaceId)`** (`stream.ts`) opens a Workspace's event stream as any client would and resolves once the server has subscribed it. `next()` waits for the next event, `expectQuiet()` fails if one arrives, `ended()` waits for the server to end the stream, and `close()` drops it; `stop()` ends any still open.
- **Flows** (`flows.ts`): `setUp(cronk)`, `signIn(cronk)` and `addMember(cronk, adminCookie, workspaceId, email)` (added by email, joined through the link, signed in) for tests whose subject comes after them; `createGitHubApp(cronk, adminCookie)` and `signInWithGitHub(cronk, account)`, which follows the browser's redirects between Cronk and GitHub. Keep them few; a test about setup or sign-in itself spells the requests out.

Faults and external services are staged through the harness, never by mocking Cronk's own modules: the stand-in GitHub, the stand-in fire endpoint and the fake Runner are three; later tickets add more stand-in HTTP servers as `startCronk` options.

## Writing a test

```ts
let cronk: StartedCronk;
beforeEach(async () => { cronk = await startCronk(); });
afterEach(async () => { await cronk?.stop(); });

test("a sign-in lasts 30 days", async () => {
  await setUp(cronk);
  const cookie = await signIn(cronk);
  cronk.clock.advance(days(30));
  expect((await cronk.request("GET", "/api/me", { cookie })).status).toBe(401);
});
```

Name tests after the behaviour, in `CONTEXT.md`'s vocabulary. Expected values come from the spec or a worked example, never recomputed the way the code computes them.

## Running tests

The tests need a Postgres server (16 or later) they may create and drop databases on. They connect to `CRONK_TEST_DATABASE_URL`, by default `postgres://postgres:postgres@localhost:5432/postgres`. Any Postgres works, for example:

```sh
docker run -d --name cronk-test-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16-alpine
```

Then:

| Command | Runs |
| --- | --- |
| `npm run typecheck` | The type checker over the server, web client and tests |
| `npm test` | The API tests (Vitest) |
| `npx vitest run test/api/sign-in.test.ts` | One test file |
| `npx vitest run test/mcp` | The MCP tests |
| `npm run test:e2e` | Builds the web client, then the Playwright smoke tests. The first time, install a browser with `npx playwright install chromium` |

Test databases are dropped when each test stops; templates (`cronk_template_*`) are kept for the next run and can be dropped at any time.
