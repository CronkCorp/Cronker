import { Type, type Static } from "typebox";
import type { Clock } from "../clock.js";
import { transaction, type Db, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
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
});
export type Comment = Static<typeof Comment>;

type Row = Omit<Comment, "createdAt" | "mentions"> & { createdAt: Date };

const columns = `comments.id, comments.ticket_id as "ticketId", comments.reply_to_id as "replyToId", comments.body,
  ${actorColumn("actors")} as actor, comments.created_at as "createdAt"`;

async function rowsOf(db: Db | Tx, ticketId: string, commentId?: string): Promise<Row[]> {
  const { rows } = await db.query<Row>(
    `select ${columns} from comments join users actors on actors.id = comments.actor_user_id
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

export async function commentsOn(db: Db, userId: string, ticketId: string): Promise<Comment[]> {
  const ticket = await findTicketRow(db, userId, ticketId);
  if (!ticket) throw ticketNotFound();
  return present(db, ticket.workspaceId, await rowsOf(db, ticket.id));
}

export async function addComment(
  db: Db,
  clock: Clock,
  userId: string,
  ticketId: string,
  input: { body: string; replyToId?: string },
): Promise<Comment> {
  return transaction(db, async (tx) => {
    const ticket = await findTicketRow(tx, userId, ticketId);
    if (!ticket) throw ticketNotFound();
    if (input.replyToId !== undefined) {
      const { rowCount } = isUuid(input.replyToId)
        ? await tx.query("select 1 from comments where id = $1 and ticket_id = $2", [input.replyToId, ticket.id])
        : { rowCount: 0 };
      if (rowCount === 0) throw new ApiError(400, "unknown_comment", "Replies go to a Comment on the same Ticket.");
    }
    const { rows } = await tx.query<{ id: string }>(
      `insert into comments (workspace_id, ticket_id, reply_to_id, actor_user_id, body, created_at)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [ticket.workspaceId, ticket.id, input.replyToId ?? null, userId, input.body, clock.now()],
    );
    const [comment] = await present(tx, ticket.workspaceId, await rowsOf(tx, ticket.id, rows[0]!.id));
    return comment!;
  });
}
