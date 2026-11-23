# Setting up Cronk

This guide takes a new installation from nothing to a delegated Ticket whose Runs happen in Claude Code on the web, spending your own Claude subscription. Follow the steps in order; each says what you should see when it worked. The configuration reference is in `README.md`.

You need:

- a machine that can run Docker Compose, or Node.js 22+ with Postgres 16+;
- a stable public HTTPS address for it (step 1);
- a Claude plan that includes Claude Code on the web, with your GitHub account connected to claude.ai so its sessions can work on your Repository;
- a GitHub account (or organization) to own Cronk's GitHub App, if you want to sign in with GitHub.

## 1. Give Cronk a public address

claude.ai's connector, GitHub's sign-in callback and, later, webhooks all reach Cronk at one address, `CRONK_PUBLIC_URL`. It must be HTTPS (plain `http` only works for `localhost`, which is enough to look around but not for Runs) and must not change: the GitHub App and the claude.ai connector both remember it.

**On a server.** Put Cronk behind any reverse proxy that terminates TLS (Caddy, nginx, a cloud load balancer) and forwards to Cronk's port, `3000` by default. Its address is then something like `https://cronk.example.com`.

**On your own machine, behind a tunnel.** Use a tunnel with a name that stays the same between restarts:

- Cloudflare Tunnel: a named tunnel (`cloudflared tunnel create cronk`, then route a hostname you own to it, pointing at `http://localhost:3000`). Quick tunnels (`cloudflared tunnel --url …`) get a new random address on every start, so don't use them.
- Tailscale Funnel: `tailscale funnel 3000` publishes `https://<machine>.<tailnet>.ts.net`.
- ngrok: a reserved domain, `ngrok http --url=<your-domain> 3000`.

Check it: opening the address should reach whatever listens on port 3000 (nothing yet, so an error from the tunnel saying so is fine).

## 2. Start Cronk and enter the setup code

Choose a secret key and keep it somewhere safe: it encrypts the GitHub App's credentials and your Runners' trigger tokens, and a different key can't read what the old one encrypted. Without one, Cronk runs, but can't create the GitHub App or save triggers.

```sh
git clone https://github.com/CronkCorp/Cronker.git && cd Cronker
git checkout "$(git describe --tags --abbrev=0)"  # the latest release; leave out to run main
cat > .env <<EOF
CRONK_PUBLIC_URL=https://cronk.example.com
CRONK_SECRET_KEY=$(openssl rand -base64 32)
POSTGRES_PASSWORD=$(openssl rand -hex 16)
EOF
docker compose up -d --build
docker compose logs cronk | grep "setup code"
```

Without Docker, run `npm ci && npm run build`, then `npm start` with `CRONK_PUBLIC_URL`, `CRONK_SECRET_KEY` and `DATABASE_URL` (a Postgres database Cronk may create tables in) set in its environment; the setup code is in its output. Attachments are kept as files in `CRONK_ATTACHMENTS_DIR` (by default `data/attachments` under the directory Cronk starts in), so back that directory up with the database.

The log line says `Cronk is not set up yet. Open it and enter this setup code: cronk_setup_…`. Open the address, enter the setup code, your email, a password and a name for your first Workspace, and choose **Set up**. The setup code works once; while nobody has set Cronk up, each start logs a new one.

You are signed in, and Cronk offers to connect GitHub.

## 3. Create the GitHub App (optional)

The GitHub App lets people sign in with GitHub, and lets Cronk read the Pull Requests of the Repositories it's installed on and hear about them through webhooks. It is also allowed to write to those Repositories, which milestone 3 needs: Runs will push branches and open Pull Requests with its token, and agents will merge through Cronk where a Project allows it. Cronk itself never commits to a Repository. One App serves the whole installation.

On the **Connect GitHub** screen (or later, as an Admin, on the **GitHub** page), choose **Create GitHub App**. To own it from a GitHub organization rather than your own account, name the organization first. GitHub shows the App Cronk asks for, named after Cronk's address: allowed to read email addresses; to read metadata, checks, commit statuses and issues; and to read and write contents and pull requests, subscribed to pull request, pull request review, check run, check suite, status and repository events (the last for renames and transfers), with its webhook pointing at Cronk. You may rename it. Confirm, and GitHub sends you back to Cronk, which stores the App's credentials and webhook secret.

The **GitHub** page now names the App, and says it has everything Cronk needs. Sign out and back in with **Sign in with GitHub** to check it: the first time, GitHub links your account to your User by its verified primary email. Install the App from its page on GitHub on the accounts and organizations whose Repositories Cronk should work with; the **GitHub** page lists the installations and their Repositories.

**An App created earlier**, for sign-in only or before Cronk wrote to Repositories, can't be changed by Cronk. As an Admin, the **GitHub** page asks GitHub what the App has and lists what it lacks: the permissions and events to add (an App that only reads lacks *Read and write* on contents and pull requests; one created before Cronk imported issues lacks *Read-only* on issues, under Repository permissions), and the webhook URL and secret to paste, with a link to the App's settings on GitHub. Add them there and reload the page. GitHub never shows a webhook secret, so the webhook stays listed until a delivery arrives signed with Cronk's; to check at once, redeliver one from the App's Advanced settings on GitHub. GitHub then asks the owner of each installation to accept the new permissions; the page lists the installations that haven't yet.

GitHub doesn't retry a webhook delivery that failed, so on startup and every five minutes Cronk asks GitHub for the App's recent deliveries and has each failed one it hasn't applied sent again. GitHub keeps deliveries for three days: if Cronk or its tunnel is down longer than that, what GitHub sent meanwhile is lost.

With *issues* read, an Admin can import a Repository's issues into a Project that lists it: **Import issues** beside the Repository in the Project's settings. It runs in the background, a page of issues every few seconds, and shows how many it imported and skipped. Open issues land in the Project's first Backlog Status, issues closed as not planned in its first Canceled Status and other closed ones in its first Done Status as Verified, each with its title, body, Labels and a link to the issue; nothing is delegated, and Pull Requests are left out. Importing again skips the issues already imported. While the App's installation hasn't accepted *issues* read, the import is refused and the **GitHub** page lists what to add and accept.

To skip it, choose **Skip for now**; email and password sign-in is enough for everything below.

## 4. Create a Project and an Agent

1. On your Workspace's page, create a Project with a name and a short key such as `CRONK`. Its board starts with the default Statuses: `Backlog → Triage [haiku] → Ready → Investigate [sonnet] → Implement [opus] → Code review [sonnet] → In Review → Done`, plus Canceled. A Status's Step and model are in the Project's **Settings**.
2. On **Agents**, create an Agent, for example `claude-max`. Runs act as it, and so does Claude Code you connect by hand.

## 5. Add Cronk to claude.ai as a custom connector

The scheduled tasks reach Cronk through a claude.ai connector, which signs in by OAuth: no token is ever pasted into claude.ai.

1. In claude.ai, open **Settings → Connectors** and add a custom connector. Name it `Cronk` and give it Cronk's MCP address: `https://cronk.example.com/mcp`.
2. Connect it. claude.ai opens Cronk's consent screen: sign in if asked, pick the Agent from step 4, and allow it.

On the Agent's page in Cronk, the connection is now listed among its tokens under claude.ai's name. Revoking it there disconnects claude.ai.

## 6. Create one routine per model

A routine (a scheduled task in Claude Code on the web) fixes its model, Repository and connectors, so you need one per model your Steps use. The default board uses three model labels: `haiku` (Triage), `sonnet` (Investigate and Code review) and `opus` (Implement). Your own Claude Code can create them for a Project (below), or you create them by hand.

### With Claude Code

You need Claude Code on your machine, signed in with your claude.ai subscription, the `Cronk` connector added to claude.ai (step 5), and the Project's Repository added on its **Settings**, which needs the GitHub App (step 3).

1. On **Runners**, set up a subscription Runner, for example `Claude Max`, and on the Agent's page set its **Runner** to it (step 7, items 1 and 4).
2. On the Runner's card, choose **Set up with Claude Code**, pick the Project (and, with several Agents pointed at the Runner, the one whose Transcript hook token to make) and choose **Make the command**. Cronk shows the routines it plans, one per model label the Project's board uses, each with the exact model id the Workspace maps its label to. An Admin changes those on the Workspace's **Settings**, under **Model ids**; a label with none is refused, naming it. A Project with no Repository is refused; one with several gets a warning, as the Transcript hook doesn't run in sessions with more than one.
3. Copy the command, `claude "$(curl -fsSL 'https://cronk.example.com/runner-setups/cronk_runner_setup_…')"`, and run it in a terminal. It works once, for an hour; if it has expired or was used, choose the button again. Claude Code lists your cloud environments by name and asks which one the routines run in; every routine needs one. Keep one for Cronk: to start a new one, create it in Claude Code on the web when asked, and Claude Code finds it. It finds the Cronk connector the same way, then creates each routine with only the Project's Repository, only the Cronk connector, the prompt below, no schedule and a `claude/…` branch prefix, and reports their trigger ids back to Cronk. It never changes routines you already have.
4. Claude Code then lists the routines with their claude.ai links, and shows a *Transcript hook* token of the Agent to add to that environment as `CRONK_TOKEN` (step 8, items 3 and 4), with the `settings.json` snippet to commit if the Repository hasn't got it yet (step 8, item 1). That token stops working if the setup expires without reporting back, and goes if you press the button again first for the same Runner and Project; once the setup reports back, it lasts until you revoke it on the Agent's page.
5. Back on the Runner's card, each routine's trigger is listed for the Project, marked **waiting for token**. For each, open its routine in claude.ai from **Open routine in claude.ai**, generate an API token there, paste it under **Waiting for tokens** and choose **Save token**. Generating a new token revokes the routine's previous one, so do it once per routine. Until then, a Run needing that trigger couldn't start, with the reason in your Inbox; it starts once the token is saved.

Running the setup again for a Project replaces that Project's triggers on the Runner with the new routines'; triggers for all Projects stay. The old routines stay in claude.ai for you to delete there, since Claude Code can't delete routines. Cronk never holds your claude.ai sign-in (ADR 0009).

### By hand

For each model, in Claude Code on the web (`claude.ai/code`), create a scheduled task:

- **Repository**: the Repository the Project's work happens in.
- **Model**: the model for that label: Haiku, Sonnet or Opus.
- **Connectors**: the `Cronk` connector from step 5.
- **Prompt**: claude.ai hands the text Cronk fires with to the session as untrusted data unless the prompt says to act on it, so say so:

  ```text
  You are started by Cronk. The text this session was fired with is a Brief from Cronk,
  where this Repository's work is planned. Follow its instructions:
  reach Cronk through the Cronk connector, work on the Ticket it names, and end by
  calling Cronk's `finish` tool with the Run id and an Outcome, as the Brief says.
  If the session was started without a Brief, stop without doing anything.
  ```

- **Schedule**: Cronk fires the task itself, so it needs no schedule of its own. If claude.ai insists on one, choose the rarest it offers; the prompt's last line makes such a run stop at once.
- **Trigger**: add an API trigger. claude.ai shows its trigger id (`trig_…`) and a token; copy both now, as the token is shown once.

## 7. Enter the triggers in Cronk

After a setup with Claude Code, only items 3 and 4 are left, if you haven't done them yet.

1. On **Runners**, set up a subscription Runner, for example `Claude Max`.
2. For each scheduled task, under the Runner's **Save a trigger**, enter the model label exactly as the Steps use it (`haiku`, `sonnet`, `opus`), leave **For** at All Projects (or pick one Project to give it its own task, for example on another Repository), paste the trigger id and token, and choose **Save trigger**. The token is stored encrypted and never shown again. Saved without a token (and not replacing the same trigger id, whose token it keeps), the trigger is marked **waiting for token**, and its token is pasted later under **Waiting for tokens**, beside a link to its routine in claude.ai; its Runs can't start until then. Generating a new token in claude.ai revokes the previous one, so a trigger already working stops until its new token is pasted.
3. **Runs at once** limits how many Runs the Runner has going together (2 by default; change it with **Save limit**); Tickets beyond it wait, highest Priority first.
4. On the Agent's page, set **Runner** to the new Runner.

Check it: create a Ticket, open it, choose **Delegate to an Agent**, and set its Status to Triage. Its Timeline shows `claude-max ran the Triage Step on haiku: running`, with a **Session** link to the claude.ai session. That session reads the Ticket through the connector and calls `finish`; the Ticket then moves to Ready on the board, or, if the Run asked a Question, back to Backlog with the Question in your **Inbox**.

When a Run can't start, the Ticket waits in your Inbox as *couldn't start*, with the reason, such as a model with no trigger or a trigger waiting for its token. Pasting the token into a trigger waiting for it starts the Tickets that couldn't start for want of it; for any other reason, fix it and choose **Retry**. A rate limit from claude.ai pauses the Runner until claude.ai says to try again. Cronk can't ask claude.ai whether a session has ended, so a Run that stops calling Cronk becomes lost after the Workspace's lost-Run threshold (30 minutes by default, set by an Admin on the Workspace's members page) and waits in your Inbox with **Retry**. With the Transcript hook from step 8, Cronk also learns when a session ends its turn: a Run whose session ends its turn without calling `finish` and then calls nothing for 5 minutes fails, *the session ended its turn without calling `finish`*, and waits in your Inbox with **Retry** well before the threshold. A late `finish` from it is refused, as for any failed Run.

## 8. Install the Transcript hook

Each Run's Transcript, the verbatim record of what its agent said and did, reaches Cronk through a Claude Code hook that Cronk serves itself, so its version always matches your Cronk. After every turn (`Stop`) it uploads the session's transcript, which Cronk matches to the Run by its session. An upload tells Cronk the session ended its turn: if the Run is still running and nothing names it or its Ticket for 5 minutes after (no tool call, no Cronk call), the Run fails, while a session woken within them, such as by activity on its pull request, keeps running. During a turn the hook tells Cronk the Run is still working after a tool call (`PostToolUse`), on the first one after a `Stop` and then at most once every 5 minutes, so a Run whose session is busy never becomes lost. A single tool call that runs longer than the lost-Run threshold still sends nothing until it ends, since `PostToolUse` comes after the tool. The hook never fails the agent's turn: if Cronk can't be reached or refuses the upload, it says why on stderr and lets the session carry on.

1. On **Runners**, the subscription Runner's card shows a **Transcript hook** section with a `settings.json` snippet, Cronk's address already in it. Commit it as `.claude/settings.json` in each Repository the scheduled tasks work on, merging it into any hooks already there. Its commands fetch the script from `https://cronk.example.com/hooks/transcript.mjs` (afresh after every turn, so it follows Cronk's upgrades) and run it with Node.js; they need `curl` and `node`, both in Claude Code on the web's sessions.
2. Under the snippet, choose **Make a Transcript hook token for claude-max**. Copy the token now: Cronk shows it once. It is an ordinary token of the Agent, named *Transcript hook*, so revoking it on the Agent's page stops only the hook's uploads.
3. In Claude Code on the web, open the cloud environment of the scheduled tasks and add the token to its environment variables as `CRONK_TOKEN=cronk_agent_…`.
4. Let that environment reach Cronk: give it **Full** network access, or keep it **Limited** and add Cronk's host (`cronk.example.com`) to its allowlist. Without that, uploads fail and the Transcript stays empty.

Hooks only run in cloud sessions with **one Repository**: a scheduled task with several Repositories gets no Transcripts, and its Runs become lost if they work longer than the lost-Run threshold without calling Cronk.

Check it: delegate a Ticket and let its Run take a turn. In its Timeline the Run gains a **Transcript** link beside **Session**, and the Transcript fills in after each turn. If none appears, the session's hook output (`/hooks` in the session, or its log) shows the hook's reason, such as `Cronk answered 401` for a revoked token.

## 9. Connect Claude Code on your laptop

Claude Code on your own machine connects to Cronk with an Agent's token.

1. On the Agent's page, issue a token: name it (`laptop`), choose **Full: read and comment** (or **Read-only**), and choose **Issue token**. Copy it now: Cronk shows it once and keeps only its hash.
2. Add Cronk as an MCP server:

   ```sh
   claude mcp add --transport http cronk https://cronk.example.com/mcp --header "Authorization: Bearer cronk_agent_…"
   ```

3. Check it: `claude mcp list` shows `cronk` as connected, and in Claude Code, asking it to list the Tickets of your Project answers from Cronk.

Revoking the token on the Agent's page cuts it off from the next request.

To keep Transcripts of what Claude Code on your laptop does, commit the step 8 snippet in the Repository (or put it in your own `~/.claude/settings.json`) and export `CRONK_TOKEN` with one of the Agent's full tokens in the shell Claude Code starts from. Its sessions match no Run, so each is kept as the Agent's own Transcript.

## 10. Run on the Claude API instead (optional)

A Managed Agents Runner runs your Agents' Runs as sessions in your own Anthropic workspace, spending its Claude API credits rather than your Claude subscription, and needs none of steps 5 to 8: Cronk sets everything up itself.

1. In the [Claude Console](https://platform.claude.com), make an API key in the workspace the Runs should spend.
2. On **Runners**, under **Set up a Runner**, give it a name such as `Claude API`, choose the kind **Managed Agents (Claude API)**, paste the key and choose **Set up a Managed Agents Runner**. Cronk checks the key with Anthropic at once: a rejected key is reported and nothing is set up. The key is stored encrypted (it needs `CRONK_SECRET_KEY`) and never shown again.
3. Cronk creates one agent definition, `Cronk: Claude API`, with Cronk's MCP server and its default tools allowed without asking (an unattended Run can't answer a confirmation), and one cloud environment with unrestricted network access, in that workspace. The Runner's card names both; edit the environment in the Console if your Runs should reach less.
4. On the Agent's page, set **Runner** to the new Runner.

Each Run is then a session of that agent on its Step's model (`haiku`, `sonnet`, `opus` and `fable` stand for the current models of that name; a Step may also name a model id in full, such as `claude-opus-4-8`), with the Brief as its first message. The session reaches Cronk with a fresh token of the Agent, kept in a vault of the Run's own and revoked, with the vault deleted, as soon as the Run ends. Its Timeline's **Session** link opens the session in the Console (in the workspace `default`; in another workspace, swap its id into the address).

The session mounts every Repository the Run's Project lists, each with a GitHub App installation token of its own, so it needs the App to be set up (step 4) with `contents: write` and `pull_requests: write` accepted on each installation; a Project listing none starts sessions with none. GitHub's tokens last an hour: while a Run runs, Cronk sets a fresh one on each of its session's Repositories about ten minutes before the one it holds expires, so long Runs keep pushing. A Repository the App no longer covers keeps the Run from starting, saying which, and it waits in your Inbox with **Retry**.

These Runs need no Transcript hook: their **Transcript** link is there from the start, and Cronk fills it from the session's events itself, scrubbed and capped as any Transcript. Opening it while the Run runs fetches what the session did since it was last opened; once the Run ends and its session is archived, Cronk fetches the rest, or, if Anthropic can't be reached then, at its next poll.

Cronk reads the sessions of running Runs every three minutes. A session that went idle without the agent calling `finish` fails its Run with the stop reason Anthropic gave (such as `end_turn` or `retries_exhausted`), one asking for a confirmation fails it as *needs a confirmation*, and a terminated one fails it; each waits in your Inbox with **Retry**. A Run with no Cronk calls for the lost-Run threshold becomes lost, as with any Runner. Stopping a Run, by moving, undelegating or re-delegating its Ticket, interrupts its session; every ended Run's session is archived, never deleted, so its Console link keeps working. Its token is revoked the moment it ends; if Anthropic can't be reached then, Cronk deletes the vault and archives the session at its next poll. A rate limit from Anthropic pauses the Runner's queue until its retry time, while Tickets wait. Removing the Runner stops its running Runs and revokes their tokens.

A webhook makes those ends immediate instead of up to three minutes late. It is optional, and polling stays as the backstop, since Anthropic drops a delivery after three failed tries:

1. Copy the **Webhook URL** from the Runner's card. Anthropic only delivers to a public HTTPS address on port 443, so `CRONK_PUBLIC_URL` must be one.
2. In the Claude Console, under **Manage → Webhooks**, add an endpoint with that URL, subscribed to `session.status_idled` and `session.status_terminated`.
3. Paste the endpoint's `whsec_` signing secret, which the Console shows once, under **Signing secret** on the card and choose **Save secret**. It is stored encrypted and never shown again; after rotating it in the Console, save the new one.

Cronk refuses deliveries that aren't signed with the saved secret, or signed more than five minutes ago, and counts on Anthropic to send one again when it can't read the session at that moment; a delivery about a session of none of the Runner's running Runs, or one Anthropic sends again, changes nothing. Each Runner has its own URL and secret: two Runners with keys to the same Anthropic workspace each need their own endpoint there.

Saving checks only that the secret starts with `whsec_`. With a wrong one, or none, every delivery is refused, and the Console disables an endpoint whose deliveries keep failing; Runs still end by polling. If the Console shows the endpoint disabled, save the right secret, then enable the endpoint again there. To stop using the webhook, choose **Forget it** on the card and remove the endpoint in the Console.

Each Run records what its session cost at Anthropic's list prices once it ends: the Run shows it on the Ticket's timeline, the Ticket's side panel totals its Runs, and the Runner's card totals its Runs that ended this calendar month (in UTC). List prices are not what a discounted contract bills, so your invoice may be lower. Subscription Runs report no cost. To cap what one Run may spend, set the card's **Budget per Run** (in US dollars; empty, the default, is none): each session started from then on gets it as its budget, and a Run whose session reaches it fails with *budget reached* and waits in your Inbox with **Retry**. A session may pass its budget by up to one model request before Anthropic stops it.

## 11. Get your Inbox on your phone (optional)

Each User can add **webhooks** for a Workspace under **Account settings → Webhooks**: a name, an `https` URL and the Inbox kinds it gets. A new webhook gets Questions, *needs you* and Runs gone wrong (failed, lost and unstarted Runs); To review, Unverified, Discovered, Undelegated, New knowledge (Decisions, Terms, Documents and Artifacts an Agent created) and, for Admins, To reassign can be added. Plain `http` is accepted only to `localhost`, `127.0.0.1` or `[::1]`, and only when Cronk itself runs on `http://localhost`. So that a webhook can't be used to probe the network Cronk runs in, a URL whose host is or resolves to a private, loopback, link-local or otherwise non-public address, such as `10.0.0.5`, `192.168.1.10`, `169.254.169.254` or `fd00::1`, is refused, and each delivery checks the address it connects to again, so a host whose DNS changes to one later isn't contacted; redirects aren't followed. The exception is `localhost`, `127.0.0.1` and `[::1]` on a Cronk running on `http://localhost`. To deliver to a receiver on your own network, such as Home Assistant, start Cronk with `CRONK_WEBHOOKS_ALLOW_PRIVATE=true`: only whoever runs the server can set it, and it lets every User's webhooks reach private addresses (still over `https`). A webhook saved with a private address before Cronk refused them gets no deliveries until it is set. Webhooks need `CRONK_SECRET_KEY`, since Cronk keeps each one's secret encrypted to sign with.

Adding one shows its **secret** once, `whsec_` and 32 random bytes in base64. **Send test** sends a delivery about a made-up Ticket, `TEST-1`, within a few seconds, and the webhook lists its last 20 deliveries with each try's status code and time. A delivery your receiver doesn't answer with a 2xx in 10 seconds is tried again 30 seconds later, then after 1, 2, 4 minutes and so on, doubling, the last try 24 hours after the first (13 tries in all). Retries repeat the body and `webhook-id`, with a fresh timestamp and signature. If the last try fails too, the webhook shows **Failing** on the settings page until a delivery to it succeeds, such as a Send test once the receiver is fixed. Removing a User from the Workspace removes their webhooks there.

### The delivery

Each delivery is a `POST` with `Content-Type: application/json` and a body such as:

```json
{
  "id": "8d0f6f8e-5f4b-4f63-9d0e-3c4b9a8a1e21",
  "kind": "question",
  "workspace": "acme",
  "ticket": { "key": "CRONK-12", "title": "Fix the lost Runs", "url": "https://cronk.example.com/acme/tickets/CRONK-12" },
  "run": "a19d534d-457c-4bbe-b025-c6d78095207f",
  "at": "2026-11-22T15:22:29.347Z"
}
```

- `kind`: the Inbox kind, `question`, `needsYou`, `run`, `review`, `unverified`, `discovered`, `reassign`, `undelegated` or `knowledge`, or `test` for **Send test**.
- `workspace`: the Workspace's slug.
- `ticket`: its key, title and address. A delivery never carries a description or Comments.
- `item`, in place of `ticket` for New knowledge (`knowledge`): its kind (`decision`, `term`, `document` or `artifact`), title (a Term's name) and address. It never carries the knowledge's text.
- `run`: the Run's id, when the item has one.
- `at`: when the item appeared.
- `id`: the delivery's id.

Its headers follow [Standard Webhooks](https://www.standardwebhooks.com), so its libraries verify it with the secret as it is:

- `webhook-id`: the delivery's id.
- `webhook-timestamp`: when it was sent, in seconds since 1970.
- `webhook-signature`: `v1,` then the base64 HMAC-SHA256 of `<webhook-id>.<webhook-timestamp>.<body>`, keyed with the secret's bytes after `whsec_`, decoded from base64.

To check one by hand, compute that HMAC over the body exactly as received, compare it in constant time, and refuse timestamps more than five minutes old. A receiver answering anything but 2xx, or not answering within 10 seconds, shows the delivery as failed.

### Example: ntfy

[ntfy](https://ntfy.sh) shows a plain `POST`'s body as a phone notification, but doesn't check signatures. Point a webhook straight at a topic with a long, unguessable name to try it (`https://ntfy.sh/cronk-<random>`): the notification is the raw JSON. To verify deliveries and send a readable message, put a few lines in between, such as this Node script (any host with a public `https` address, or n8n's Webhook and Crypto nodes doing the same):

```js
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const secret = Buffer.from(process.env.CRONK_WEBHOOK_SECRET.replace(/^whsec_/, ""), "base64");
const topic = process.env.NTFY_TOPIC; // such as https://ntfy.sh/cronk-3k9f2

createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const id = req.headers["webhook-id"];
    const timestamp = req.headers["webhook-timestamp"];
    const expected = `v1,${createHmac("sha256", secret).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
    const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) < 300;
    const signed = String(req.headers["webhook-signature"] ?? "")
      .split(" ")
      .some((s) => s.length === expected.length && timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
    if (!fresh || !signed) return res.writeHead(401).end();
    const { kind, ticket } = JSON.parse(body);
    await fetch(topic, {
      method: "POST",
      headers: { Title: `${ticket.key}: ${kind}`, Click: ticket.url },
      body: ticket.title,
    });
    res.writeHead(204).end();
  });
}).listen(8080);
```

## Upgrading

Releases are tagged `v0.x.y` on GitHub, with notes listing what changed: [Releases](https://github.com/CronkCorp/Cronker/releases). Read the notes of every release you skip: they call out anything to do by hand, such as a GitHub App permission to accept.

1. **Back up** the database and the Attachments; Cronk's migrations only go forward.

   ```sh
   docker compose exec -T postgres pg_dump -U cronk cronk > cronk-$(date +%F).sql
   docker compose cp cronk:/app/data/attachments ./attachments-$(date +%F)
   ```

2. **Check out the new release and rebuild.**

   ```sh
   git fetch --tags
   git checkout "$(git describe --tags --abbrev=0 origin/main)"
   docker compose up -d --build
   ```

   Without Docker: check out the release the same way, then `npm ci && npm run build` and restart `npm start`.

3. **Check it came up.** Cronk applies new migrations itself when it starts, one start at a time; `docker compose logs cronk` shows them, and then Cronk listening. Upgrade when no Runs are running if you can: a Run whose session can't reach Cronk while it restarts may fail or be lost, and then waits in your Inbox with Retry.

To go back, restore the backup into an empty database and check out the release you came from: a newer database can't be used by an older Cronk.

## When something goes wrong

- **Nobody can sign in.** `docker compose exec cronk node dist/server/command.js reset-link you@example.com` prints a one-time password reset link, valid 7 days.
- **The setup code is not right.** Use the one from the latest start; each start logs a new one until setup is done.
- **"Cronk has no CRONK_SECRET_KEY"** when creating the GitHub App or saving a trigger: set it and restart.
- **The GitHub App or the connector stopped working after the address changed.** Both remember `CRONK_PUBLIC_URL`. Keep the address stable; if it must change, update the App's URLs on GitHub and add the connector again in claude.ai.
