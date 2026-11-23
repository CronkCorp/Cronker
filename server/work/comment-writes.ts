import type { Context } from "../context.js";
import type { Tx } from "../db.js";
import { indexMentions } from "./mentions.js";
import { publishArtifactComments } from "./artifact-comment-events.js";

/*
 * Kept apart from `comments.ts`, whose schema needs `tickets.ts` loaded: Questions write Comments from
 * `runs.ts`, which `tickets.ts` imports as it loads.
 */

/**
 * Writes a Comment on the Ticket as the Actor, or as Cronk itself, telling the Workspace, and returns its id. `sentBack`
 * marks Cronk's Comment on a send-back, written at the time of the move it explains.
 */
export async function insertComment(
  { clock, live }: Context,
  tx: Tx,
  ticket: { id: string; workspaceId: string; projectId: string },
  actor: { kind: "user" | "agent"; id: string } | { kind: "cronk" },
  body: string,
  replyToId: string | null,
  sentBack: { at: Date } | null = null,
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `insert into comments (workspace_id, ticket_id, reply_to_id, actor_user_id, actor_agent_id, body, created_at, sent_back)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [
      ticket.workspaceId,
      ticket.id,
      replyToId,
      actor.kind === "user" ? actor.id : null,
      actor.kind === "agent" ? actor.id : null,
      body,
      sentBack?.at ?? clock.now(),
      sentBack !== null,
    ],
  );
  const commentId = rows[0]!.id;
  await indexMentions(tx, "comment", { id: commentId, workspaceId: ticket.workspaceId, projectId: ticket.projectId }, body);
  live.publish(tx, ticket.workspaceId, { type: "comment.added", projectId: ticket.projectId, ticketId: ticket.id, commentId });
  return commentId;
}

/**
 * Writes a Comment on the Artifact as the Actor, telling the Workspace, the Tickets linking it among it, and returns
 * its id.
 */
export async function insertArtifactComment(
  context: Context,
  tx: Tx,
  artifact: { id: string; workspaceId: string; projectId: string | null },
  actor: { kind: "user" | "agent"; id: string },
  body: string,
  replyToId: string | null,
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `insert into comments (workspace_id, artifact_id, reply_to_id, actor_user_id, actor_agent_id, body, created_at)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [
      artifact.workspaceId,
      artifact.id,
      replyToId,
      actor.kind === "user" ? actor.id : null,
      actor.kind === "agent" ? actor.id : null,
      body,
      context.clock.now(),
    ],
  );
  const commentId = rows[0]!.id;
  await indexMentions(tx, "comment", { id: commentId, workspaceId: artifact.workspaceId, projectId: artifact.projectId }, body);
  await publishArtifactComments(context, tx, artifact, (ticket) => ({ type: "comment.added", ...ticket, commentId }));
  return commentId;
}

/**
 * Writes a Comment on the Document, a Report included, as the Actor, on its whole or on the passage it quotes from the
 * Version given, telling its readers, and returns its id.
 */
export async function insertDocumentComment(
  context: Context,
  tx: Tx,
  document: { id: string; workspaceId: string; projectId: string | null },
  actor: { kind: "user" | "agent"; id: string },
  body: string,
  replyToId: string | null,
  quote: { quote: string; version: number } | null = null,
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `insert into comments (workspace_id, document_id, reply_to_id, actor_user_id, actor_agent_id, body, created_at,
       quote, quote_version)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [
      document.workspaceId,
      document.id,
      replyToId,
      actor.kind === "user" ? actor.id : null,
      actor.kind === "agent" ? actor.id : null,
      body,
      context.clock.now(),
      quote?.quote ?? null,
      quote?.version ?? null,
    ],
  );
  const commentId = rows[0]!.id;
  await indexMentions(tx, "comment", { id: commentId, workspaceId: document.workspaceId, projectId: document.projectId }, body);
  context.live.publish(tx, document.workspaceId, {
    type: "comment.added",
    projectId: document.projectId,
    documentId: document.id,
    commentId,
  });
  return commentId;
}
