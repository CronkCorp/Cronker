# Cronk

A self-hosted platform where humans and AI agents share Tickets, Documents, Terms and Decisions, and where Cronk launches agent Runs on delegated Tickets itself. See `AGENTS.md` for where the design lives.

## Running Cronk

```sh
CRONK_PUBLIC_URL=https://cronk.example.com docker compose up -d
docker compose logs cronk | grep "setup code"
```

Open the public address, enter the setup code from the log, and create the first User and their Workspace. The setup code works once; each start of a fresh installation logs a new one.

Cronk itself doesn't need Docker: it is a Node.js (22+) server and a Postgres (16+) database. `npm ci && npm run build && npm start` runs it anywhere, configured by the same environment variables.

### When nobody can sign in

A server command prints a one-time password reset link for any User, valid 7 days:

```sh
docker compose exec cronk node dist/server/command.js reset-link ada@example.com
```

Without Docker, run `npm run command -- reset-link ada@example.com` with the server's environment variables.

### Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `CRONK_PUBLIC_URL` | yes | The public HTTPS address Cronk is reached at, such as `https://cronk.example.com` or a tunnel's address. Plain `http` is accepted only for `localhost`. |
| `DATABASE_URL` | yes | Postgres connection URL. Migrations run on start. |
| `PORT` | no | Port to listen on (default `3000`). |
| `HOST` | no | Address to listen on (default `0.0.0.0`). |
| `CRONK_WEB_ROOT` | no | Directory of the built web client (default: `dist/web`). |

The Compose file also reads `CRONK_PORT` (published port, default `3000`) and `POSTGRES_PASSWORD`.

The API is documented at `/api/docs` (OpenAPI at `/api/openapi.json`).

## Developing

```sh
npm ci
DATABASE_URL=postgres://… CRONK_PUBLIC_URL=http://localhost:5173 npm run dev   # API on :3000
npm run dev:web                                                               # web client on :5173
```

Tests: see `docs/testing.md`.
