import { Type, type Static } from "typebox";
import type { Db, Tx } from "../db.js";
import { Actor, actorColumn } from "./actors.js";

/** What a Change changed. `created` marks the Ticket's creation. */
export const changeFields = [
  "created",
  "title",
  "description",
  "status",
  "priority",
  "labels",
  "assignee",
  "dueDate",
  "estimate",
] as const;
export type ChangeField = (typeof changeFields)[number];

export const Change = Type.Object({
  id: Type.String({ format: "uuid" }),
  actor: Actor,
  at: Type.String({ format: "date-time" }),
  field: Type.Union(changeFields.map((f) => Type.Literal(f))),
  from: Type.Unknown({
    description:
      "The value before: a string, number, list of Labels, or for a Status or Assignee `{ id, name }` as named then; null when empty.",
  }),
  to: Type.Unknown({ description: "The value after, in the same form as `from`." }),
});
export type Change = Static<typeof Change>;

export interface NewChange {
  field: ChangeField;
  from: unknown;
  to: unknown;
}

export async function recordChanges(
  tx: Tx,
  ticket: { id: string; workspaceId: string },
  actorUserId: string,
  at: Date,
  changes: NewChange[],
): Promise<void> {
  for (const change of changes) {
    await tx.query(
      `insert into changes (workspace_id, ticket_id, actor_user_id, at, field, from_value, to_value)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [ticket.workspaceId, ticket.id, actorUserId, at, change.field, json(change.from), json(change.to)],
    );
  }
}

// pg sends a JS array as a Postgres array, so jsonb values go as JSON text.
const json = (value: unknown) => (value === null ? null : JSON.stringify(value));

/** A Ticket's Changes, oldest first. */
export async function changesOf(db: Db, ticketId: string): Promise<Change[]> {
  const { rows } = await db.query<Omit<Change, "at"> & { at: Date }>(
    `select changes.id, ${actorColumn("actors")} as actor, changes.at, changes.field,
       changes.from_value as from, changes.to_value as to
     from changes join users actors on actors.id = changes.actor_user_id
     where changes.ticket_id = $1 order by changes.seq`,
    [ticketId],
  );
  return rows.map((row) => ({ ...row, at: row.at.toISOString() }));
}
