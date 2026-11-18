import { Type, type Static } from "typebox";
import type { Clock } from "../clock.js";
import { transaction, type Db, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import { recordChanges } from "./changes.js";
import { findTicketRef, findTicketRow, ticketNotFound, TicketRef, ticketRefColumn, unknownTicket } from "./tickets.js";

/** A Relation as seen from one of its Tickets: this Ticket blocks, is blocked by, or relates to the other. */
export const RelationKind = Type.Union([Type.Literal("blocks"), Type.Literal("blockedBy"), Type.Literal("relatesTo")]);
export type RelationKind = Static<typeof RelationKind>;

export const Relation = Type.Object({
  id: Type.String({ format: "uuid" }),
  kind: RelationKind,
  ticket: TicketRef,
});
export type Relation = Static<typeof Relation>;

export const TicketRelations = Type.Object({
  parent: Type.Union([TicketRef, Type.Null()]),
  subTickets: Type.Array(TicketRef, { description: "By key." }),
  relations: Type.Array(Relation, { description: "Oldest first." }),
});
export type TicketRelations = Static<typeof TicketRelations>;

export async function addRelation(
  db: Db,
  clock: Clock,
  userId: string,
  ticketId: string,
  input: { kind: RelationKind; ticketId: string },
): Promise<Relation> {
  return transaction(db, async (tx) => {
    const ticket = await findTicketRow(tx, userId, ticketId);
    if (!ticket) throw ticketNotFound();
    const other = await findTicketRef(tx, ticket.workspaceId, input.ticketId);
    if (!other) throw unknownTicket();
    if (other.id === ticket.id) throw new ApiError(400, "relation_to_itself", "A Ticket can't be related to itself.");
    const [from, to] = input.kind === "blockedBy" ? [other.id, ticket.id] : [ticket.id, other.id];
    if (input.kind !== "relatesTo" && (await blocksTransitively(tx, ticket.workspaceId, to, from))) {
      throw new ApiError(
        400,
        "blocking_cycle",
        "That block would form a cycle: the other Ticket already waits on this one.",
      );
    }
    const { rows } = await tx.query<{ id: string }>(
      `insert into relations (workspace_id, kind, ticket_id, other_ticket_id, created_by, created_at)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (kind, least(ticket_id, other_ticket_id), greatest(ticket_id, other_ticket_id)) do nothing
       returning id`,
      [ticket.workspaceId, input.kind === "relatesTo" ? "relates" : "blocks", from, to, userId, clock.now()],
    );
    if (!rows[0]) throw new ApiError(409, "relation_exists", "These Tickets already have that Relation.");
    const self = (await findTicketRef(tx, ticket.workspaceId, ticket.id))!;
    await recordRelationChanges(tx, ticket.workspaceId, userId, clock.now(), input.kind, self, other, "added");
    return { id: rows[0]!.id, kind: input.kind, ticket: other };
  });
}

function relationNotFound(): ApiError {
  return new ApiError(404, "not_found", "This Ticket has no such Relation.");
}

export async function removeRelation(
  db: Db,
  clock: Clock,
  userId: string,
  ticketId: string,
  relationId: string,
): Promise<void> {
  await transaction(db, async (tx) => {
    const ticket = await findTicketRow(tx, userId, ticketId);
    if (!ticket || !isUuid(relationId)) throw relationNotFound();
    const { rows } = await tx.query<{ kind: "blocks" | "relates"; ticketId: string; otherTicketId: string }>(
      `delete from relations where id = $1 and $2 in (ticket_id, other_ticket_id)
       returning kind, ticket_id as "ticketId", other_ticket_id as "otherTicketId"`,
      [relationId, ticket.id],
    );
    const removed = rows[0];
    if (!removed) throw relationNotFound();
    const from = (await findTicketRef(tx, ticket.workspaceId, removed.ticketId))!;
    const to = (await findTicketRef(tx, ticket.workspaceId, removed.otherTicketId))!;
    const kind = removed.kind === "relates" ? "relatesTo" : "blocks";
    await recordRelationChanges(tx, ticket.workspaceId, userId, clock.now(), kind, from, to, "removed");
  });
}

const opposite: Record<RelationKind, RelationKind> = {
  blocks: "blockedBy",
  blockedBy: "blocks",
  relatesTo: "relatesTo",
};

/** Records a Relation added or removed on both its Tickets' timelines, each naming the other Ticket. */
async function recordRelationChanges(
  tx: Tx,
  workspaceId: string,
  userId: string,
  at: Date,
  kind: RelationKind,
  ticket: TicketRef,
  other: TicketRef,
  how: "added" | "removed",
): Promise<void> {
  const change = (field: RelationKind, ref: TicketRef) =>
    how === "added" ? { field, from: null, to: ref } : { field, from: ref, to: null };
  await recordChanges(tx, { id: ticket.id, workspaceId }, userId, at, [change(kind, other)]);
  await recordChanges(tx, { id: other.id, workspaceId }, userId, at, [change(opposite[kind], ticket)]);
}

/**
 * Whether one Ticket blocks another, directly or through others. Holds the Workspace's blocks still until the
 * transaction ends, so two blocks made at once can't close a cycle between them.
 */
async function blocksTransitively(tx: Tx, workspaceId: string, blocker: string, blocked: string): Promise<boolean> {
  await tx.query("select pg_advisory_xact_lock(hashtext('blocks'), hashtext($1))", [workspaceId]);
  const { rowCount } = await tx.query(
    `with recursive reached (id) as (
       select $1::uuid
       union
       select relations.other_ticket_id from relations join reached on relations.ticket_id = reached.id
       where relations.kind = 'blocks'
     )
     select 1 from reached where id = $2`,
    [blocker, blocked],
  );
  return (rowCount ?? 0) > 0;
}

export async function relationsOf(db: Db, userId: string, ticketId: string): Promise<TicketRelations> {
  const ticket = await findTicketRow(db, userId, ticketId);
  if (!ticket) throw ticketNotFound();
  const { rows } = await db.query<Relation>(
    `select relations.id,
       case when relations.kind = 'relates' then 'relatesTo'
            when relations.ticket_id = $1 then 'blocks' else 'blockedBy' end as kind,
       ${ticketRefColumn("others", "projects")} as ticket
     from relations
     join tickets others on others.id =
       case when relations.ticket_id = $1 then relations.other_ticket_id else relations.ticket_id end
     join projects on projects.id = others.project_id
     where $1 in (relations.ticket_id, relations.other_ticket_id)
     order by relations.seq`,
    [ticket.id],
  );
  const parent = ticket.parentId === null ? null : (await findTicketRef(db, ticket.workspaceId, ticket.parentId))!;
  const subTickets = await db.query<{ ref: TicketRef }>(
    `select ${ticketRefColumn("tickets", "projects")} as ref
     from tickets join projects on projects.id = tickets.project_id
     where tickets.parent_id = $1 order by tickets.number`,
    [ticket.id],
  );
  return { parent, subTickets: subTickets.rows.map((row) => row.ref), relations: rows };
}
