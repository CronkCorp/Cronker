# Testing

Tests exercise Cronk from the outside, the way a User or Agent does: they call the HTTP API (or drive the web client) and assert on responses and on what later calls return. They never read tables, import internal modules or call private functions, so the inside can be refactored freely. Only the harness reaches in, and only for what starting Cronk takes: `createCronk` and the migrations that build its template database. Rules are not tested through lower-level unit seams.

## Seams

These are the seams from the milestone 1 spec (#1). Tests live only at them.

1. **HTTP API against a real, disposable Postgres** (primary). Cronk runs in-process with the clock under the test's control. Nearly every rule is tested here, live updates included, by reading a Workspace's event stream over HTTP. Lives in `test/api/`.
2. **The Runner interface with a fake Runner.** API tests start Cronk with a fake Runner that records each start and can be told to refuse, rate-limit or report a Run ended without finishing. *(Not built yet.)*
3. **The subscription Runner against a stand-in HTTP server** for the scheduled-task fire endpoint. The real service is never called. *(Not built yet.)*
4. **MCP** (thin): a real MCP client against the running server, for bearer tokens, OAuth and the mapping of tools onto the API. *(Not built yet.)*
5. **Sign in with GitHub against a stand-in OAuth server.** *(Not built yet.)*
6. **Web UI smoke tests** (Playwright): a few walk the main path in a real browser. The web client holds no rules, so it gets no further tests. Lives in `e2e/`.

What a seam can't see, such as that only hashes of secrets are stored, is kept by code review rather than by tests reaching past the seam.

## The harness

`test/harness/` holds what every test starts from:

- **`startCronk()`** (`start-cronk.ts`) creates a disposable database, starts Cronk in-process listening on a free local port, and returns:
  - `url`: Cronk's address, which is also its configured public address, so the browser and `Origin` checks see the same thing.
  - `request(method, path, { body, cookie, origin, headers })`: a `fetch` against it. It sends no `Origin` unless asked, like a non-browser client.
  - `clock`: the test's clock (below).
  - `logs` and `setupCode()`: everything Cronk logged, and the setup code a fresh installation logs.
  - `command(...args)`: runs a server command (`server/command.ts`) in a child process against this Cronk's database, as an operator would, and returns its exit code, stdout and stderr.
  - `stop()`: closes Cronk and drops its database. Call it in `afterEach`.
- **Disposable Postgres per test** (`database.ts`). Each `startCronk()` copies a fresh database from a migrated template (`create database … template …`), so tests share nothing and none pays for migrations. The template's name carries a hash of `migrations/`, so changing a migration builds a new template on the next run.
- **The injectable clock** (`clock.ts`). Cronk reads the time only through its `Clock`. `TestClock` starts at a fixed instant and moves only on `clock.advance(ms)`; `days(n)` helps. Use it for anything that expires.
- **`openStream(cronk, cookie, workspaceId)`** (`stream.ts`) opens a Workspace's event stream as any client would and resolves once the server has subscribed it. `next()` waits for the next event, `expectQuiet()` fails if one arrives, `ended()` waits for the server to end the stream, and `close()` drops it; `stop()` ends any still open.
- **Flows** (`flows.ts`): `setUp(cronk)`, `signIn(cronk)` and `addMember(cronk, adminCookie, workspaceId, email)` (added by email, joined through the link, signed in) for tests whose subject comes after them. Keep them few; a test about setup or sign-in itself spells the requests out.

Faults and external services are staged through the harness, never by mocking Cronk's own modules: later tickets add the fake Runner and stand-in HTTP servers as `startCronk` options.

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
| `npm run test:e2e` | Builds the web client, then the Playwright smoke tests. The first time, install a browser with `npx playwright install chromium` |

Test databases are dropped when each test stops; templates (`cronk_template_*`) are kept for the next run and can be dropped at any time.
