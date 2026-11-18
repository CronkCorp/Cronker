import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { transaction, type Db, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import type { Caller } from "../identity/callers.js";
import type { Viewer } from "../identity/viewers.js";
import { Actor, actorColumn } from "./actors.js";
import { findTicketRow, Mention, mentionsInEach, ticketNotFound } from "./tickets.js";

export const Comment = Type.Object({
  id: Type.String({ format: "uuid" }),
  ticketId: Type.String({ format: "uuid" }),
  replyToId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
  body: Type.String({ description: "Markdown." }),
  actor: Actor,
  createdAt: Type.String({ format: "date-time" }),
  mentions: Type.Array(Mention, { description: "Ticket keys the body mentions." }),
  questionId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
    description: "The Question this Comment asks, if a Run asked one with it; the first User's reply answers it.",
  }),
});
export type Comment = Static<typeof Comment>;

type Row = Omit<Comment, "createdAt" | "mentions"> & { createdAt: Date };

const columns = `comments.id, comments.ticket_id as "ticketId", comments.reply_to_id as "replyToId", comments.body,
  ${actorColumn("users", "agents")} as actor, comments.created_at as "createdAt", questions.id as "questionId"`;

async function rowsOf(db: Db | Tx, ticketId: string, commentId?: string): Promise<Row[]> {
  const { rows } = await db.query<Row>(
    `select ${columns} from comments
     left join users on users.id = comments.actor_user_id
     left join agents on agents.id = comments.actor_agent_id
     left join questions on questions.comment_id = comments.id
     where comments.ticket_id = $1 ${commentId ? "and comments.id = $2" : ""}
     order by comments.seq`,
    commentId ? [ticketId, commentId] : [ticketId],
  );
  return rows;
}

/** Comments as the API shows them, finding the Ticket keys of all their bodies at once. */
async function present(db: Db | Tx, workspaceId: string, rows: Row[]): Promise<Comment[]> {
  const mentions = await mentionsInEach(db, workspaceId, rows.map((row) => row.body));
  return rows.map((row, i) => ({ ...row, createdAt: row.createdAt.toISOString(), mentions: mentions[i]! }));
}

export async function commentsOn(db: Db, viewer: Viewer, ticketId: string): Promise<Comment[]> {
  const ticket = await findTicketRow(db, viewer, ticketId);
  if (!ticket) throw ticketNotFound();
  return present(db, ticket.workspaceId, await rowsOf(db, ticket.id));
}

export async function addComment(
  context: Context,
  actor: Caller,
  ticketId: string,
  input: { body: string; replyToId?: string },
): Promise<Comment> {
  return transaction(context.db, async (tx) => {
    const ticket = await findTicketRow(tx, actor, ticketId);
    if (!ticket) throw ticketNotFound();
    if (input.replyToId !== undefined) {
      const { rowCount } = isUuid(input.replyToId)
        ? await tx.query("select 1 from comments where id = $1 and ticket_id = $2", [input.replyToId, ticket.id])
        : { rowCount: 0 };
      if (rowCount === 0) throw new ApiError(400, "unknown_comment", "Replies go to a Comment on the same Ticket.");
    }
    const commentId = await insertComment(context, tx, ticket, actor, input.body, input.replyToId ?? null);
    const [comment] = await present(tx, ticket.workspaceId, await rowsOf(tx, ticket.id, commentId));
    return comment!;
  });
}

/** Writes a Comment on the Ticket as the Actor, telling the Workspace, and returns its id. */
export async function insertComment(
  { clock, live }: Context,
  tx: Tx,
  ticket: { id: string; workspaceId: string; projectId: string },
  actor: { kind: "user" | "agent"; id: string },
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
