import { Type, type Static } from "typebox";
import type { Clock } from "../clock.js";
import { transaction, type Db, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import { Actor, actorColumn } from "./actors.js";
import { findTicketRow, Mention, mentionsIn, ticketNotFound } from "./tickets.js";

export const Comment = Type.Object({
  id: Type.String({ format: "uuid" }),
  ticketId: Type.String({ format: "uuid" }),
  replyToId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
  body: Type.String({ description: "Markdown." }),
  author: Actor,
  createdAt: Type.String({ format: "date-time" }),
  mentions: Type.Array(Mention, { description: "Ticket keys the body mentions." }),
});
export type Comment = Static<typeof Comment>;

type Row = Omit<Comment, "createdAt" | "mentions"> & { createdAt: Date };

const columns = `comments.id, comments.ticket_id as "ticketId", comments.reply_to_id as "replyToId", comments.body,
  ${actorColumn("authors")} as author, comments.created_at as "createdAt"`;

async function rowsOf(db: Db | Tx, ticketId: string, commentId?: string): Promise<Row[]> {
  const { rows } = await db.query<Row>(
    `select ${columns} from comments join users authors on authors.id = comments.author_user_id
     where comments.ticket_id = $1 ${commentId ? "and comments.id = $2" : ""}
     order by comments.created_at, comments.id`,
    commentId ? [ticketId, commentId] : [ticketId],
  );
  return rows;
}

async function present(db: Db | Tx, workspaceId: string, row: Row): Promise<Comment> {
  return { ...row, createdAt: row.createdAt.toISOString(), mentions: await mentionsIn(db, workspaceId, row.body) };
}

export async function commentsOn(db: Db, userId: string, ticketId: string): Promise<Comment[]> {
  const ticket = await findTicketRow(db, userId, ticketId);
  if (!ticket) throw ticketNotFound();
  return Promise.all((await rowsOf(db, ticket.id)).map((row) => present(db, ticket.workspaceId, row)));
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
      `insert into comments (workspace_id, ticket_id, reply_to_id, author_user_id, body, created_at)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [ticket.workspaceId, ticket.id, input.replyToId ?? null, userId, input.body, clock.now()],
    );
    const [row] = await rowsOf(tx, ticket.id, rows[0]!.id);
    return present(tx, ticket.workspaceId, row!);
  });
}
