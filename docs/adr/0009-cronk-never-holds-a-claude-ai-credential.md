# Cronk never holds a claude.ai credential

A subscription Runner's claude.ai routines are created only by the User's own Claude Code, on their own machine, during a Runner setup. Cronk serves the instructions and stores only what comes back: each routine's trigger id, and later the trigger token the User generates in claude.ai and pastes into Cronk, sealed under `CRONK_SECRET_KEY`. It never asks for, receives or keeps the User's claude.ai sign-in.

The routines API Claude Code uses (`/v1/code/triggers`, behind its `RemoteTrigger` tool) is undocumented and signs in with the User's subscription OAuth token, which reaches everything the User can do in claude.ai. Holding it would make every Cronk installation a store of its Users' Claude accounts, and tie Cronk to an API that may change without notice. So everything that depends on that API's shape lives in the instructions Cronk serves, which a Cronk release can change without a migration, and firing a routine stays on the documented `/fire` endpoint with the routine's own token.

## Consequences

- Setup is never fully automatic. claude.ai has no documented way to make a routine's token, so the User generates one per routine in claude.ai; each new trigger waits for it on the Runner's card. claude.ai keeps no environment variables on a routine, so the User also adds the Transcript hook token to the cloud environment by hand.
- Cronk can't reuse, update or delete routines. A setup always creates new ones, and the User deletes old ones in claude.ai.
- The Managed Agents Runner is unaffected: it uses a Claude API key, a credential made for that purpose.
