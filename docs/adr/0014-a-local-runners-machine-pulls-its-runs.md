# A local Runner's Machine pulls its Runs

A `local` Runner runs Runs on its Owner's own computer, a **Machine**, through Claude Code's CLI signed in with their own subscription. Every Runner before it is pushed: Cronk calls out to claude.ai or the Managed Agents API to start a session. Cronk can't reach a Machine: it sits behind NAT and firewalls, sleeps, and changes networks. So this Runner is **pulled**. Its `start` reaches no Machine and answers *started* with no session reference; the Run waits until a Machine serving the Runner claims it. A small daemon, `cronk-runner`, keeps a connection to Cronk open from the Machine, claims Runs, runs them and reports back.

The Runner interface stays as it is. The daemon talks to Cronk over its HTTP API with a **Machine token**, which it receives by a device-code flow: `cronk-runner login <url>` asks for a code, the User approves the short code on the Runners page while signed in, picking which of their own `local` Runners the Machine serves, and the daemon polls until it receives its token, once. A code expires after ten minutes. Cronk keeps only the token's hash; the daemon keeps it in a config file only its User can read. A Machine belongs to the User who approved it and serves only their own Runners, so a Run always spends its Owner's own Claude subscription. Unpairing revokes the token.

The claude.ai sign-in never leaves the Machine, so ADR 0009 holds: Cronk holds no claude.ai credential.

## Considered Options

- **Cronk pushes to the Machine** through a tunnel (such as a reverse SSH tunnel or a hosted relay). It keeps every Runner pushed, but asks the User to run and secure an inbound service on their computer, or Cronk to depend on a relay.
- **The User pastes a long-lived token into the daemon**, as for an Agent's token. Simpler, but a secret copied by hand ends up in shell history and chat; a short code approved while signed in pairs without moving a secret.
- **One Machine shared by several Users.** Left out: a Run would then spend whoever's Claude sign-in the Machine has, not its Owner's.

## Consequences

- Delegated Tickets on a `local` Runner wait while no Machine serving it is online, and start when one comes back; a Run whose Machine sleeps becomes lost by the usual rule and comes back on its next call.
- A `local` Runner isn't a cloud Runner, so `local-only` Tickets go to it.
- The daemon is a second package built from this repository and released with Cronk, so both sides of the protocol move together.
- Pairing (CRONK-138) comes first; claiming, heartbeats, Transcripts, stops and the background service follow (CRONK-139 and after).
