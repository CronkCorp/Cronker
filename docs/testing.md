# Testing

Tests exercise Cronk from the outside, the way a User or Agent does: they call the HTTP API (or drive the web client) and assert on responses and on what later calls return. They never read tables, import internal modules or call private functions, so the inside can be refactored freely. Only the harness reaches in, and only for what starting Cronk takes: `createCronk` and the migrations that build its template database. The one exception is a test of a migration that moves data an earlier Cronk wrote: it writes those rows as that Cronk did (`stage()`, below), since today's API can no longer write them, and reads the result through the API. Rules are not tested through lower-level unit seams.

## Seams

These are the seams from the milestone 1 spec (#1). Tests live only at them.

1. **HTTP API against a real, disposable Postgres** (primary). Cronk runs in-process with the clock under the test's control, keeping Attachments in a disposable directory. Nearly every rule is tested here, live updates included, by reading a Workspace's event stream over HTTP. Lives in `test/api/`.
2. **The Runner interface with a fake Runner.** Every `startCronk()` installs a fake Runner (`test/harness/runner.ts`) as the Runner kind `fake`. It records each start and stop and can be told to refuse the next start (rate limits included) or to report a Run ended without finishing. Agents' own calls, such as `finish`, come through the API or MCP. Lives in `test/api/runs.test.ts`, `test/api/runs-gone-wrong.test.ts`, `test/api/delegation.test.ts`, `test/api/agent-work.test.ts` (what an Agent does inside its Run: edits, Reports and its last call), `test/api/reports.test.ts` (Reports as Documents, and milestone 1's moved over), `test/api/agents-creating-tickets.test.ts` (Sub-Tickets and Discovered Tickets an Agent files) and `test/api/leaving.test.ts` (an Admin removing a User from a Workspace).
3. **The subscription Runner against a stand-in HTTP server** for the scheduled-task fire endpoint. Every `startCronk()` points Cronk at a stand-in (`test/harness/claude.ts`); the real service is never called. Lives in `test/api/subscription-runner.test.ts`, with one Playwright walk through the Runners page in `e2e/runners.spec.ts`.
4. **MCP** (thin): a real MCP client (the MCP SDK's) against the running server, for bearer tokens, OAuth and the mapping of tools onto the API. Lives in `test/mcp/` (attaching a file as base64 included); the OAuth flow's rules (consent, codes, refresh, Client ID Metadata Documents) are tested at the API in `test/api/oauth.test.ts`, with one Playwright walk through the consent screen in `e2e/connect.spec.ts`. A test publishes a client's metadata document from its own local HTTP server: a Cronk on plain http, which only a local one may be, accepts plain http metadata document URLs.
5. **GitHub against a stand-in GitHub.** Every `startCronk()` points Cronk at a stand-in GitHub (`test/harness/github.ts`) for the manifest flow, OAuth sign-in, account lookups, the App's own calls with its JWT (what it has, its webhook, its installations), installation tokens, the repositories an installation covers (listed, or one by id, as after a rename), and the App's signed webhook deliveries with their log and redeliveries; the real GitHub is never called. Sign-in and creating the App live in `test/api/github.test.ts`, upgrading the App, installations and their tokens in `test/api/github-app.test.ts`, webhooks in `test/api/github-webhooks.test.ts`, Repositories on Projects (renames and transfers, and key clashes across Workspaces) in `test/api/repositories.test.ts`, with Playwright walks through them in `e2e/github.spec.ts` and `e2e/repositories.spec.ts`.
6. **Web UI smoke tests** (Playwright): a few walk the main path in a real browser. The web client holds no rules, so it gets no further tests. Lives in `e2e/`; `e2e/main-path.spec.ts` walks the whole of it with the fake Runner, from setup to Accepting an Unverified completion.

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
  - `replayFailedDeliveries()`: runs the check the server runs on startup and every five minutes, which has the stand-in GitHub redeliver the App's failed webhook deliveries Cronk hasn't applied.
  - `request(method, path, { body, cookie, origin, headers })`: a `fetch` against it. It sends no `Origin` unless asked, like a non-browser client.
  - `clock`: the test's clock (below).
  - `logs` and `setupCode()`: everything Cronk logged, and the setup code a fresh installation logs.
  - `attachmentFiles()`: the files in the disposable directory this Cronk keeps Attachments in, by name (each an Attachment's id), to check that a removed Attachment's file is gone. `startCronk({ attachmentLimitBytes })` sets the size limit of each Attachment (25 MB by default).
  - `terminateIdleDatabaseConnections()`: terminates Cronk's idle database connections from an admin connection, as a Postgres restart or failover would, and returns how many it terminated.
  - `stage(sql, params)` and `upgrade()`, for a test of a migration: `startCronk({ migrateBefore: "0022_reports_documents.sql" })` starts Cronk on a database migrated short of that migration (no template, so it pays for its migrations); the test sets things up through the API, stages with `stage()` the rows only an earlier Cronk wrote, then `upgrade()` restarts Cronk, on a new address (`url` follows it), applying the rest. `test/api/reports.test.ts` moves milestone 1's Reports into Documents this way.
  - `command(...args)`: runs a server command (`server/command.ts`) in a child process against this Cronk's database, as an operator would, and returns its exit code, stdout and stderr.
  - `stop()`: closes Cronk, drops its database and removes its Attachments' directory. Call it in `afterEach`.
- **Disposable Postgres per test** (`database.ts`). Each `startCronk()` copies a fresh database from a migrated template (`create database … template …`), so tests share nothing and none pays for migrations. The template's name carries a hash of `migrations/`, so changing a migration builds a new template on the next run.
- **The injectable clock** (`clock.ts`). Cronk reads the time only through its `Clock`. `TestClock` starts at a fixed instant and moves only on `clock.advance(ms)`; `days(n)` and `hours(n)` help. Use it for anything that expires.
- **The stand-in GitHub** (`github.ts`). A local HTTP server answering as GitHub does, redirects included, for creating a GitHub App from a manifest, authorizing it to sign in (OAuth), looking up accounts, and the App's API calls. `github.account(login, email?)` adds an account GitHub knows of; `github.signedInAs` is the account the browser is signed in to GitHub as, who approves at once; `github.apps` lists the Apps created, each with the `permissions`, `events`, `webhookUrl` and `webhookSecret` its manifest asked for, which a test edits as an Admin would in the App's settings. `github.install(app, account, repositories)` installs an App, accepting its permissions at that moment; an installation keeps them until `installation.accept()`. `github.tokensIssued` lists every installation token issued; tokens last an hour by the test's clock. `github.deliver(app, event, payload, { id, secret })` sends a webhook delivery to the App's webhook URL, signed with its secret (another, or `null` for none) and returns Cronk's answer; sending an `id` again is a redelivery. `fails: "unreachable"` stages a delivery that never reached Cronk, `fails: "timed out"` one Cronk got but GitHub gave up waiting for; either is logged as failed. `github.deliveries` is each App's delivery log, which the App lists and asks redeliveries from, `github.redeliveries(app)` the attempts it asked for, and `github.refuseNextRedelivery()` answers the next redelivery request with 422. It checks the App's JWT against its key and the test's clock. Cronk starts with a random `CRONK_SECRET_KEY`, or none with `startCronk({ noSecretKey: true })`.
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
