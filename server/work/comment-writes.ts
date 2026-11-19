import type { Context } from "../context.js";
import type { Tx } from "../db.js";

/*
 * Kept apart from `comments.ts`, whose schema needs `tickets.ts` loaded: Questions write Comments from
 * `runs.ts`, which `tickets.ts` imports as it loads.
 */

/** Writes a Comment on the Ticket as the Actor, or as Cronk itself, telling the Workspace, and returns its id. */
export async function insertComment(
  { clock, live }: Context,
  tx: Tx,
  ticket: { id: string; workspaceId: string; projectId: string },
  actor: { kind: "user" | "agent"; id: string } | { kind: "cronk" },
  body: string,
  replyToId: string | null,
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `insert into comments (workspace_id, ticket_id, reply_to_id, actor_user_id, actor_agent_id, body, created_at)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [
      ticket.workspaceId,
      ticket.id,
      replyToId,
      actor.kind === "user" ? actor.id : null,
      actor.kind === "agent" ? actor.id : null,
      body,
      clock.now(),
    ],
  );
  const commentId = rows[0]!.id;
  live.publish(tx, ticket.workspaceId, { type: "comment.added", projectId: ticket.projectId, ticketId: ticket.id, commentId });
  return commentId;
}
