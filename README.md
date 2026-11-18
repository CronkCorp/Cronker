# Cronk

A self-hosted platform where humans and AI agents share Tickets, Documents, Terms and Decisions, and where Cronk launches agent Runs on delegated Tickets itself. See `AGENTS.md` for where the design lives.

## Running Cronk

To set up an installation from scratch, through to Runs in Claude Code on the web and Claude Code on a laptop, follow `docs/setup.md`. In short:

```sh
CRONK_PUBLIC_URL=https://cronk.example.com docker compose up -d
docker compose logs cronk | grep "setup code"
```

Open the public address, enter the setup code from the log, and create the first User and their Workspace. The setup code works once; each start of a fresh installation logs a new one.

### Signing in with GitHub

Right after setup, Cronk offers to create the installation's GitHub App through GitHub's manifest flow: GitHub asks you to confirm the App (under your GitHub account or a GitHub organization you name), then sends you back to Cronk, which stores the App's credentials encrypted with `CRONK_SECRET_KEY`. You can skip it and have any Admin create it later from the **GitHub** page. An installation has one App; it is used only for signing in for now.

Once it exists, Users can sign in with GitHub. A GitHub account is linked to its User at the first sign-in: the User an Admin added by that GitHub login, or else the User whose email is the account's verified primary email. Admins add people by GitHub login on the Members page; they join at their next sign-in with GitHub. GitHub accounts no User has are refused. A User may sign in both ways.

### Running Runs on your Claude subscription

A User's Agents start Runs through one of that User's Runners, set up on the **Runners** page. The subscription Runner fires Claude Code on the web scheduled tasks, spending the User's own Claude subscription. In claude.ai, create one scheduled task per model you want Runs on (for example triage on Haiku, investigate on Sonnet, implement on Opus) with the Repository and Cronk's connector, add an API trigger, and write its prompt to follow the instructions in the fire payload: claude.ai hands the fire text to the session as untrusted data unless the prompt says to act on it. On the Runners page, save each task's trigger id and token under the model label its Steps use, for all Projects or overriding them for one Project, then point your Agents at the Runner. Cronk sends the Run's Brief as the fire text and never a secret; tokens are stored encrypted with `CRONK_SECRET_KEY` and never shown again. When claude.ai rate limits a Runner, its queue pauses until the time claude.ai gives and Tickets keep waiting; a missing trigger or a rejected token puts the Ticket in the Inbox as *couldn't start*, with the reason. Cronk can't tell when a claude.ai session ends, so a Run that stops calling Cronk becomes lost after the Workspace's lost-Run threshold.

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
| `CRONK_SECRET_KEY` | for GitHub and Runners | At least 32 characters, such as the output of `openssl rand -base64 32`. Encrypts the secrets Cronk keeps, such as the GitHub App's credentials and Runners' trigger tokens. Keep it: a different key can't read what the old one encrypted. |
| `CRONK_GITHUB_URL` | no | GitHub's web address (default `https://github.com`), for GitHub Enterprise Server. |
| `CRONK_GITHUB_API_URL` | no | GitHub's API address (default `https://api.github.com`), such as `https://github.example.com/api/v3`. |
| `CRONK_CLAUDE_API_URL` | no | The Claude API's address (default `https://api.anthropic.com`), whose scheduled-task fire endpoint the subscription Runner calls. |

The Compose file also reads `CRONK_PORT` (published port, default `3000`), `POSTGRES_PASSWORD` and `CRONK_SECRET_KEY`.

The API is documented at `/api/docs` (OpenAPI at `/api/openapi.json`).

### Connecting an agent

Each User creates Agents of their own on a Workspace's **Agents** page and issues them tokens, full (read and comment) or read-only. A token is shown once; Cronk keeps only its hash, and revoking it or removing its Agent refuses it from the next request.

An Agent's token works as `Authorization: Bearer …` on the HTTP API, and on Cronk's MCP server (streamable HTTP at `/mcp` on the public address). For Claude Code:

```sh
claude mcp add --transport http cronk https://cronk.example.com/mcp --header "Authorization: Bearer cronk_agent_…"
```

A claude.ai custom connector (as scheduled tasks use) needs no token: add `https://cronk.example.com/mcp` as a connector in claude.ai, and connecting it opens Cronk's consent screen, where you sign in and pick which of your Agents it acts as. Cronk is the OAuth 2.1 authorization server for its MCP server, with dynamic client registration and Client ID Metadata Documents, so any MCP client that speaks OAuth connects the same way. The connection is listed among the Agent's tokens under the client's name; revoking it or removing the Agent disconnects the client. Its access tokens last an hour and are renewed with a refresh token.

For now an Agent may read its Workspace and comment on its Tickets. Anything else is refused with a stable `code`, the `rule` it met and `advice` on what it may do instead.

## Developing

```sh
npm ci
DATABASE_URL=postgres://… CRONK_PUBLIC_URL=http://localhost:5173 npm run dev   # API on :3000
npm run dev:web                                                               # web client on :5173
```

Tests: see `docs/testing.md`.
