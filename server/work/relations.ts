import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { transaction, type Db, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import { userViewer, type Viewer } from "../identity/viewers.js";
import { startUnblocked } from "../runs/runs.js";
import { recordChanges } from "./changes.js";
import {
  findTicketRef,
  findTicketRefByKey,
  findTicketRow,
  ticketNotFound,
  TicketRef,
  ticketRefColumn,
  unknownTicket,
} from "./tickets.js";

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
  context: Context,
  userId: string,
  ticketId: string,
  input: { kind: RelationKind } & ({ ticketId: string } | { ticketKey: string }),
): Promise<Relation> {
  return transaction(context.db, async (tx) => {
    const ticket = await findTicketRow(tx, userViewer(userId), ticketId);
    if (!ticket) throw ticketNotFound();
    const other =
      "ticketId" in input
        ? await findTicketRef(tx, ticket.workspaceId, input.ticketId)
        : await findTicketRefByKey(tx, ticket.workspaceId, input.ticketKey);
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
      [ticket.workspaceId, storedKind[input.kind], from, to, userId, context.clock.now()],
    );
    if (!rows[0]) throw new ApiError(409, "relation_exists", "These Tickets already have that Relation.");
    const self = (await findTicketRef(tx, ticket.workspaceId, ticket.id))!;
    await recordRelationChanges(context, tx, ticket.workspaceId, userId, input.kind, self, other, "added");
    return { id: rows[0]!.id, kind: input.kind, ticket: other };
  });
}

/** How a Relation is stored: a block always from the blocking Ticket to the blocked one. */
type StoredKind = "blocks" | "relates";
const storedKind: Record<RelationKind, StoredKind> = { blocks: "blocks", blockedBy: "blocks", relatesTo: "relates" };
/** A stored Relation as seen from its `ticket_id` side. */
const kindFromTicket: Record<StoredKind, RelationKind> = { blocks: "blocks", relates: "relatesTo" };

function relationNotFound(): ApiError {
  return new ApiError(404, "not_found", "This Ticket has no such Relation.");
}

export async function removeRelation(
  context: Context,
  userId: string,
  ticketId: string,
  relationId: string,
): Promise<void> {
  await transaction(context.db, async (tx) => {
    const ticket = await findTicketRow(tx, userViewer(userId), ticketId);
    if (!ticket) throw ticketNotFound();
    if (!isUuid(relationId)) throw relationNotFound();
    const { rows } = await tx.query<{ kind: StoredKind; ticketId: string; otherTicketId: string }>(
      `delete from relations where id = $1 and $2 in (ticket_id, other_ticket_id)
       returning kind, ticket_id as "ticketId", other_ticket_id as "otherTicketId"`,
      [relationId, ticket.id],
    );
    const removed = rows[0];
    if (!removed) throw relationNotFound();
    const from = (await findTicketRef(tx, ticket.workspaceId, removed.ticketId))!;
    const to = (await findTicketRef(tx, ticket.workspaceId, removed.otherTicketId))!;
    const kind = kindFromTicket[removed.kind];
    await recordRelationChanges(context, tx, ticket.workspaceId, userId, kind, from, to, "removed");
    if (removed.kind === "blocks") await startUnblocked(context, tx, null, [removed.otherTicketId]);
  });
}

const opposite: Record<RelationKind, RelationKind> = {
  blocks: "blockedBy",
  blockedBy: "blocks",
  relatesTo: "relatesTo",
};

/**
 * Records a Relation added or removed on both its Tickets' timelines, each naming the other Ticket, and tells
 * the Workspace's live streams both Tickets changed.
 */
async function recordRelationChanges(
  { clock, live }: Context,
  tx: Tx,
  workspaceId: string,
  userId: string,
  kind: RelationKind,
  ticket: TicketRef,
  other: TicketRef,
  addedOrRemoved: "added" | "removed",
): Promise<void> {
  const at = clock.now();
  const change = (field: RelationKind, ref: TicketRef) =>
    addedOrRemoved === "added" ? { field, from: null, to: ref } : { field, from: ref, to: null };
  for (const [one, field, otherOne] of [
    [ticket, kind, other],
    [other, opposite[kind], ticket],
  ] as const) {
    await recordChanges(tx, { id: one.id, workspaceId }, userId, at, [change(field, otherOne)]);
    live.publish(tx, workspaceId, { type: "ticket.changed", projectId: one.projectId, ticketId: one.id });
  }
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

export async function relationsOf(db: Db, viewer: Viewer, ticketId: string): Promise<TicketRelations> {
  const ticket = await findTicketRow(db, viewer, ticketId);
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
