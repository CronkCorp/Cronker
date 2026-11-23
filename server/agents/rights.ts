/**
 * What Agents may do, as one text: the MCP server's instructions and the OpenAPI agent-token security scheme both
 * say it, so the two never tell an Agent different things. The API enforces it; this only describes it.
 */
export const agentRights =
  "Agents may read their Workspace, comment on its Tickets, file Tickets, create, save and move Documents, " +
  "attaching files to Documents and to their own Comments, create and save Terms (only Users delete Documents " +
  "and Terms), create and save Artifacts (only Users delete them), and propose Decisions and edit their text (only " +
  "Users change a Decision's status). An Agent whose Owner is an Admin may also create Projects, and with Write in " +
  "a Project change its board, a Step's content only when its Owner is an Admin. With Write in a Project an Agent may also create, rename " +
  "and delete its planned Releases (only Users cut and release them). During its running Run on a Ticket " +
  "an Agent may also edit the Ticket's description, Priority, Labels, Release, due date and estimate, attach files to it, " +
  "split it into Sub-Tickets, write Reports on it, link Documents and Artifacts to it and unlink them, and finish " +
  "the Run (a Merge Step's Run may instead merge its Ticket's Pull Request with `merge_pull_request`). While it has a " +
  "running Run in a Project an Agent may also set or clear the parent of any Ticket there, which keeps its own " +
  "Delegation. A Ticket an " +
  "Agent files outside its Ticket's Sub-Tickets is a Discovered Ticket, waiting for its Assignee: until a User " +
  "delegates, moves or dismisses it the Agent may edit it, title included, add blocks from it, or make it blocked " +
  "by any Ticket of the Workspace, delegated or running included, link Documents and Artifacts to it and unlink " +
  "them, such as the spec Document it was filed from, and split it into Sub-Tickets, which are Discovered Tickets " +
  "of the same Agent and are settled along with it, so a planned piece of work is filed as one parent Ticket with " +
  "its slices under it. A read-only token may only read. Anything else is refused with the rule and what to do " +
  "instead.";
