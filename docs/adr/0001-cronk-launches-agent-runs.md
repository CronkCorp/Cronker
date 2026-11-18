# Cronk launches and tracks agent runs itself

The first Cronk recorded and coordinated Agent work but never launched agents: it marked work as waiting and left starting a session to whatever runner the User had (its ADR 0005). This rewrite reverses that. When a Ticket is delegated to AI, Cronk itself starts a cloud agent run, passes it the brief for the step, and records the run's state until it ends. The point of the rewrite is a loop where creating and delegating Tickets is all a User does to get work done; leaving the launch to an outside runner made that loop something every User had to build.

## Consequences

- Cronk holds credentials for at least one way of running agents (a Claude subscription, the Claude API, or a sandbox provider), and its scope now includes run state, failures and cost.
- The first Cronk's warning still stands: runners grow large. The surface for starting runs stays one narrow seam so the provider behind it can change.
