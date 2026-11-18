import { Type, type Static } from "typebox";
import type { Clock } from "../clock.js";
import { transaction, type Db, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import { findTicketRow, ticketNotFound } from "./tickets.js";

/** A Ticket as another Ticket's Relations, parent and Sub-Tickets name it. */
export const TicketRef = Type.Object({
  id: Type.String({ format: "uuid" }),
  projectId: Type.String({ format: "uuid" }),
  key: Type.String(),
  title: Type.String(),
});
export type TicketRef = Static<typeof TicketRef>;

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

const refColumns = (tickets: string, projects: string) =>
  `json_build_object('id', ${tickets}.id, 'projectId', ${tickets}.project_id,
     'key', ${projects}.key || '-' || ${tickets}.number, 'title', ${tickets}.title)`;

/** The other Ticket of a new Relation, which must be of the same Workspace. */
async function otherTicket(tx: Tx, workspaceId: string, ticketId: string): Promise<TicketRef> {
  const { rows } = isUuid(ticketId)
    ? await tx.query<{ ref: TicketRef }>(
        `select ${refColumns("tickets", "projects")} as ref
         from tickets join projects on projects.id = tickets.project_id
         where tickets.id = $1 and tickets.workspace_id = $2`,
        [ticketId, workspaceId],
      )
    : { rows: [] };
  if (!rows[0]) throw new ApiError(400, "unknown_ticket", "That Ticket isn't in this Workspace.");
  return rows[0].ref;
}

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
    const other = await otherTicket(tx, ticket.workspaceId, input.ticketId);
    if (other.id === ticket.id) throw new ApiError(400, "relation_to_itself", "A Ticket can't be related to itself.");
    const [from, to] = input.kind === "blockedBy" ? [other.id, ticket.id] : [ticket.id, other.id];
    if (input.kind !== "relatesTo" && (await blocksTransitively(tx, ticket.workspaceId, to, from))) {
      throw new ApiError(400, "blocking_cycle", "That block would form a cycle: the other Ticket already waits on this one.");
    }
    const { rows } = await tx.query<{ id: string }>(
      `insert into relations (workspace_id, kind, ticket_id, other_ticket_id, created_by, created_at)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (kind, least(ticket_id, other_ticket_id), greatest(ticket_id, other_ticket_id)) do nothing
       returning id`,
      [ticket.workspaceId, input.kind === "relatesTo" ? "relates" : "blocks", from, to, userId, clock.now()],
    );
    if (!rows[0]) throw new ApiError(409, "relation_exists", "These Tickets already have that Relation.");
    return { id: rows[0]!.id, kind: input.kind, ticket: other };
  });
}

function relationNotFound(): ApiError {
  return new ApiError(404, "not_found", "This Ticket has no such Relation.");
}

export async function removeRelation(db: Db, userId: string, ticketId: string, relationId: string): Promise<void> {
  await transaction(db, async (tx) => {
    const ticket = await findTicketRow(tx, userId, ticketId);
    if (!ticket || !isUuid(relationId)) throw relationNotFound();
    const { rowCount } = await tx.query(
      "delete from relations where id = $1 and $2 in (ticket_id, other_ticket_id)",
      [relationId, ticket.id],
    );
    if (rowCount === 0) throw relationNotFound();
  });
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
       ${refColumns("others", "projects")} as ticket
     from relations
     join tickets others on others.id =
       case when relations.ticket_id = $1 then relations.other_ticket_id else relations.ticket_id end
     join projects on projects.id = others.project_id
     where $1 in (relations.ticket_id, relations.other_ticket_id)
     order by relations.seq`,
    [ticket.id],
  );
  return { parent: null, subTickets: [], relations: rows };
}
