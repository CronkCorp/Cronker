import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { transaction } from "../db.js";
import { ApiError } from "../http/errors.js";
import { requireWrite, userViewer } from "../identity/viewers.js";
import { findTicketRow, ticketNotFound } from "../work/tickets.js";
import { announce, pullRequestsOf, type PullRequest } from "./pull-requests.js";

/**
 * Pull Requests a User links to a Ticket by hand (CRONK-40), when its branch or title doesn't name the Ticket's key.
 * Only a Pull Request of a Repository the Ticket's Project lists, that Cronk knows and that is open or merged, links:
 * the same Pull Requests a key could link, so a merge completes the Ticket under the same rules. A link by hand is
 * kept apart from a link by key on the same pair: GitHub's deliveries never remove it, and unlinking it leaves a link
 * by key standing.
 */

/** A Pull Request as a User names it: its address on GitHub, or `owner/name#number`. */
export function parsePullRequest(text: string): { repository: string; number: number } {
  const trimmed = text.trim();
  const named =
    /^https?:\/\/[^/\s]+\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)(?:[/?#]\S*)?$/i.exec(trimmed) ??
    /^([^/\s#]+\/[^/\s#]+)#(\d+)$/.exec(trimmed);
  const number = named ? Number(named[2]) : NaN;
  if (!named || !Number.isSafeInteger(number) || number < 1) {
    throw new ApiError(
      400,
      "invalid_pull_request",
      "Name the Pull Request by its address on GitHub, such as `https://github.com/owner/name/pull/12`, or as `owner/name#12`.",
    );
  }
  return { repository: named[1]!, number };
}

/** Links a Pull Request to a Ticket by hand, as the User; linking one already linked by hand changes nothing. */
/** The link-a-Pull-Request-by-hand route's body. */
export const PullRequestLink = Type.Object({
  pullRequest: Type.String({ minLength: 1, maxLength: 500, description: "Its address on GitHub, or `owner/name#number`." }),
});
export type PullRequestLink = Static<typeof PullRequestLink>;

export async function linkPullRequest(context: Context, userId: string, ticketId: string, text: string): Promise<PullRequest> {
  const named = parsePullRequest(text);
  const viewer = userViewer(userId);
  return transaction(context.db, async (tx) => {
    const ticket = await findTicketRow(tx, viewer, ticketId, { lock: true });
    if (!ticket) throw ticketNotFound();
    await requireWrite(tx, viewer, ticket);
    // Matched by its Repository's name now or as GitHub last reported it with the Pull Request, among those the
    // Ticket's Project lists: a Project lists Repositories of its own Workspace's choosing only.
    const { rows } = await tx.query<{ id: string; state: string }>(
      `select pull_requests.id, pull_requests.state from pull_requests
       join project_repositories on project_repositories.repository_id = pull_requests.repository_id
         and project_repositories.project_id = $1
       join repositories on repositories.id = pull_requests.repository_id
       where pull_requests.number = $3
         and (lower(repositories.full_name) = lower($2) or lower(pull_requests.repository_full_name) = lower($2))
       order by pull_requests.id limit 1`,
      [ticket.projectId, named.repository, named.number],
    );
    const found = rows[0];
    if (!found) {
      throw new ApiError(
        404,
        "pull_request_not_found",
        `Cronk knows no Pull Request ${named.repository}#${named.number} in the Repositories the Ticket's Project lists.`,
        {
          rule: "Only a Pull Request of a Repository the Ticket's Project lists links, once GitHub has told Cronk of it.",
          advice: "Add its Repository to the Project, or change the Pull Request on GitHub (such as editing its description) so GitHub tells Cronk of it, then link it again.",
        },
      );
    }
    if (found.state === "closed") {
      throw new ApiError(409, "pull_request_closed", `${named.repository}#${named.number} was closed without merging; only an open or merged Pull Request links.`);
    }
    const now = context.clock.now();
    await tx.query(
      `insert into pull_request_links (pull_request_id, ticket_id, workspace_id, producing_run_id, linked_at, by_key, manual_by, manual_at)
       values ($1, $2, $3, null, $4, false, $5, $4)
       on conflict (pull_request_id, ticket_id) do update
         set manual_by = case when pull_request_links.manual_at is null then excluded.manual_by else pull_request_links.manual_by end,
           manual_at = coalesce(pull_request_links.manual_at, excluded.manual_at)`,
      [found.id, ticket.id, ticket.workspaceId, now, userId],
    );
    await announce(context, tx, [Number(found.id)]);
    return (await pullRequestsOf(tx, viewer, ticket.id)).find((pr) => pr.id === Number(found.id))!;
  });
}

/**
 * Removes a link the User or another User made by hand, by GitHub's id for the Pull Request. A link by key on the same
 * pair stays, as links by key always do.
 */
export async function unlinkPullRequest(context: Context, userId: string, ticketId: string, pullRequestId: number): Promise<void> {
  await transaction(context.db, async (tx) => {
    const ticket = await findTicketRow(tx, userViewer(userId), ticketId, { lock: true });
    if (!ticket) throw ticketNotFound();
    await requireWrite(tx, userViewer(userId), ticket);
    const { rows } = await tx.query<{ byKey: boolean; manual: boolean }>(
      `select by_key as "byKey", manual_at is not null as manual from pull_request_links
       where pull_request_id = $1 and ticket_id = $2 for update`,
      [pullRequestId, ticket.id],
    );
    const link = rows[0];
    if (!link) throw new ApiError(404, "not_found", "That Pull Request isn't linked to the Ticket.");
    if (!link.manual) {
      throw new ApiError(409, "linked_by_key", "That Pull Request links by the Ticket's key in its branch or title, which stays linked.", {
        rule: "Only a link made by hand can be unlinked; a link by key stays as long as Cronk knows the Pull Request.",
        advice: "Leave it linked; its branch or title names the Ticket's key.",
      });
    }
    // Announced while the link still stands, so the Ticket's Workspace hears of it.
    await announce(context, tx, [pullRequestId]);
    if (link.byKey) {
      await tx.query("update pull_request_links set manual_by = null, manual_at = null where pull_request_id = $1 and ticket_id = $2", [
        pullRequestId,
        ticket.id,
      ]);
    } else {
      await tx.query("delete from pull_request_links where pull_request_id = $1 and ticket_id = $2", [pullRequestId, ticket.id]);
    }
  });
}
