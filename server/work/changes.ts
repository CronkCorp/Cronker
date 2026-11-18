import { Type, type Static } from "typebox";
import type { Db, Tx } from "../db.js";
import { Actor, actorColumn } from "./actors.js";

/** Who made a Change: a User, an Agent, or Cronk itself, such as when it moves a Ticket on past a skipped Step. */
export const ChangeActor = Type.Union([
  Actor,
  Type.Object({ kind: Type.Literal("cronk"), name: Type.Literal("Cronk") }, { description: "Cronk itself." }),
]);

/**
 * What a Change changed. `created` marks the Ticket's creation. `parent` is this Ticket's parent; `subTicket`,
 * `blocks`, `blockedBy` and `relatesTo` each show one Ticket added (from null) or removed (to null). `stepSkipped`
 * marks Cronk passing the Ticket on past a Step it didn't pass, before the `status` Change moving it.
 */
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
  "parent",
  "subTicket",
  "blocks",
  "blockedBy",
  "relatesTo",
  "delegate",
  "stepSkipped",
] as const;
export type ChangeField = (typeof changeFields)[number];

export const Change = Type.Object({
  id: Type.String({ format: "uuid" }),
  actor: ChangeActor,
  at: Type.String({ format: "date-time" }),
  field: Type.Union(changeFields.map((f) => Type.Literal(f))),
  from: Type.Unknown({
    description:
      "The value before: a string, number, list of Labels, for a Status, Assignee or Delegate `{ id, name }` as named then, " +
      "or for another Ticket `{ id, projectId, key, title }` as it was then; null when empty. A `stepSkipped` Change goes " +
      "from null to `{ status: { id, name }, labelRule, outcome }`: the Status whose Step was skipped, its Label rule " +
      "and the default Outcome the Ticket moved on by.",
  }),
  to: Type.Unknown({ description: "The value after, in the same form as `from`." }),
});
export type Change = Static<typeof Change>;

export interface NewChange {
  field: ChangeField;
  from: unknown;
  to: unknown;
}

/** Who makes a Change: a User, by id, an Agent, or Cronk itself. */
export type ChangeMaker = string | { kind: "agent"; id: string } | { kind: "cronk" };

export async function recordChanges(
  tx: Tx,
  ticket: { id: string; workspaceId: string },
  actor: ChangeMaker,
  at: Date,
  changes: NewChange[],
): Promise<void> {
  const [userId, agentId] = typeof actor === "string" ? [actor, null] : actor.kind === "agent" ? [null, actor.id] : [null, null];
  for (const change of changes) {
    await tx.query(
      `insert into changes (workspace_id, ticket_id, actor_user_id, actor_agent_id, at, field, from_value, to_value)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [ticket.workspaceId, ticket.id, userId, agentId, at, change.field, json(change.from), json(change.to)],
    );
  }
}

// pg sends a JS array as a Postgres array, so jsonb values go as JSON text.
const json = (value: unknown) => (value === null ? null : JSON.stringify(value));

/** A Ticket's Changes, oldest first. */
export async function changesOf(db: Db, ticketId: string): Promise<Change[]> {
  const { rows } = await db.query<Omit<Change, "at"> & { at: Date }>(
    `select changes.id,
       case when users.id is null and agents.id is null then json_build_object('kind', 'cronk', 'name', 'Cronk')
         else ${actorColumn("users", "agents")} end as actor,
       changes.at, changes.field,
       changes.from_value as from, changes.to_value as to
     from changes left join users on users.id = changes.actor_user_id
     left join agents on agents.id = changes.actor_agent_id
     where changes.ticket_id = $1 order by changes.seq`,
    [ticketId],
  );
  return rows.map((row) => ({ ...row, at: row.at.toISOString() }));
}
