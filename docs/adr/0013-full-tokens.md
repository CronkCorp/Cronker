# A token is Read, Write or Full

This amends ADR 0010. An Agent's token has one of three levels of **Token access**:

- **Read** may only read.
- **Write** follows the Agent rules: a Run does its Ticket and nothing else. Every token Cronk makes, for a Run, a Runner setup hook or an OAuth connection, is Write unless the Owner picks Full by hand. Tokens stored as `full` before this change became Write, so they keep exactly what they could do.
- **Full** lifts the Agent-specific rules. The Agent acts with its Owner's rights, within the least of the Agent Access, its Owner's Access and Write: Full never raises Access, it only changes which acts an Agent may take with it. A Run never holds a Full token, so delegated work can never cancel, delete or move other work.

A short list of acts stays human-only, whatever the token: Verification (Accept and Reopen), Access and Admin settings, a Decision's status, and resolving and unresolving threads. They mean "a human checked this". A Full token attempting one is refused with `human_only`; a Write token attempting a Full act gets `full_token_needed`, naming the rule. One module, `server/identity/acts.ts`, holds the check (`actsAsOwner`, `requireOwnerAct`, `requireHumanAct`), so each Agent rule asks it rather than checking `caller.kind` itself.

A Full token's acts are recorded like any Agent's: Changes by the Agent, with no Run. Moving a Ticket into a Status with a Step starts its Run, and moving a running Ticket stops it, exactly as when the Owner does it. The MCP server lists only the tools a token's level may use.

## Considered Options

- **Keep Agents narrow, and send Users to the web client.** Safe, but a User working with Claude Code on their laptop has to switch windows to cancel or move a Ticket.
- **Finer levels, such as "move and cancel only".** Closer to least privilege, but each level is a new rule to explain and test; Full is all-or-nothing until a need for something between shows.
- **The level on the Agent rather than the token.** One Agent would then be either a Run's or a laptop's; on the token, the same Agent keeps Write for its Runs and Full for its Owner's own connection.
- **A confirmation step or Inbox notice for destructive acts.** Safer against a misstep, but the Owner chose Full by hand; acts are recorded, and the timeline names the Agent.

## Consequences

- Moving Tickets is the first Full act (CRONK-123). Editing and delegating any Ticket, merges, Releases, Questions and Runs, and deleting knowledge follow in their own Tickets.
- The token dialog and the OAuth approval screen offer the levels, with a warning on Full.
