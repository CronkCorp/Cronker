# Cronk

A self-hosted platform where humans and AI agents share Tickets, Documents, Terms and Decisions, and where Cronk launches agent Runs on delegated Tickets itself. See `AGENTS.md` for where the design lives.

## Running Cronk

```sh
CRONK_PUBLIC_URL=https://cronk.example.com docker compose up -d
docker compose logs cronk | grep "setup code"
```

Open the public address, enter the setup code from the log, and create the first User and their Workspace. The setup code works once; each start of a fresh installation logs a new one.

### Signing in with GitHub

Right after setup, Cronk offers to create the installation's GitHub App through GitHub's manifest flow: GitHub asks you to confirm the App (under your GitHub account or a GitHub organization you name), then sends you back to Cronk, which stores the App's credentials encrypted with `CRONK_SECRET_KEY`. You can skip it and have any Admin create it later from the **GitHub** page. An installation has one App; it is used only for signing in for now.

Once it exists, Users can sign in with GitHub. A GitHub account is linked to its User at the first sign-in: the User an Admin added by that GitHub login, or else the User whose email is the account's verified primary email. Admins add people by GitHub login on the Members page; they join at their next sign-in with GitHub. GitHub accounts no User has are refused. A User may sign in both ways.

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
| `CRONK_SECRET_KEY` | for GitHub | At least 32 characters, such as the output of `openssl rand -base64 32`. Encrypts the secrets Cronk keeps, such as the GitHub App's credentials. Keep it: a different key can't read what the old one encrypted. |
| `CRONK_GITHUB_URL` | no | GitHub's web address (default `https://github.com`), for GitHub Enterprise Server. |
| `CRONK_GITHUB_API_URL` | no | GitHub's API address (default `https://api.github.com`), such as `https://github.example.com/api/v3`. |

The Compose file also reads `CRONK_PORT` (published port, default `3000`), `POSTGRES_PASSWORD` and `CRONK_SECRET_KEY`.

The API is documented at `/api/docs` (OpenAPI at `/api/openapi.json`).

### Connecting an agent

Each User creates Agents of their own on a Workspace's **Agents** page and issues them tokens, full (read and comment) or read-only. A token is shown once; Cronk keeps only its hash, and revoking it or removing its Agent refuses it from the next request.

An Agent's token works as `Authorization: Bearer …` on the HTTP API, and on Cronk's MCP server (streamable HTTP at `/mcp` on the public address). For Claude Code:

```sh
claude mcp add --transport http cronk https://cronk.example.com/mcp --header "Authorization: Bearer cronk_agent_…"
```

For now an Agent may read its Workspace and comment on its Tickets. Anything else is refused with a stable `code`, the `rule` it met and `advice` on what it may do instead.

## Developing

```sh
npm ci
DATABASE_URL=postgres://… CRONK_PUBLIC_URL=http://localhost:5173 npm run dev   # API on :3000
npm run dev:web                                                               # web client on :5173
```

Tests: see `docs/testing.md`.
