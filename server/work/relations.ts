import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { transaction, type Db, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import { actsAsOwner, requireOwnerAct } from "../identity/acts.js";
import { inReach, requireWrite, type Viewer } from "../identity/viewers.js";
import type { AgentCaller, Caller } from "../identity/callers.js";
import { ownerName } from "../agents/tokens.js";
import { blockingChanged } from "../runs/runs.js";
import { recordChanges, type ChangeActor } from "./changes.js";
import { statusesOf } from "./projects.js";
import {
  editTicketIn,
  type Ticket,
  findTicketRef,
  findTicketRefByKey,
  discoveringAgent,
  holdsDiscoveredTicket,
  findTicketRow,
  ticketNotFound,
  type TicketRow,
  TicketRef,
  ticketRefColumn,
  unknownTicket,
} from "./tickets.js";

/**
 * A Relation as seen from one of its Tickets: this Ticket blocks, is blocked by, or relates to the other, or was
 * closed as a duplicate of it (`duplicateOf`), or the other was closed as a duplicate of this one (`duplicatedBy`).
 */
export const RelationKind = Type.Union([
  Type.Literal("blocks"),
  Type.Literal("blockedBy"),
  Type.Literal("relatesTo"),
  Type.Literal("duplicateOf"),
  Type.Literal("duplicatedBy"),
]);
export type RelationKind = Static<typeof RelationKind>;

/** The Relations the relate route adds; a duplicate is made only by closing a Ticket as one (`closeAsDuplicate`). */
export const AddedRelationKind = Type.Union([Type.Literal("blocks"), Type.Literal("blockedBy"), Type.Literal("relatesTo")]);
export type AddedRelationKind = Static<typeof AddedRelationKind>;

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

/** The relate route's body: the Relation's kind, and the other Ticket by its id or its key. */
export const RelationCreate = Type.Union([
  Type.Object({ kind: AddedRelationKind, ticketId: Type.String({ description: "The other Ticket." }) }),
  Type.Object({
    kind: AddedRelationKind,
    ticketKey: Type.String({ description: "The other Ticket's key, such as `CRONK-12`, matched ignoring case." }),
  }),
]);
export type RelationCreate = Static<typeof RelationCreate>;

/**
 * Relates the Ticket to another of its Workspace. A User, or an Agent with a Full token, adds any Relation; any
 * other Agent only adds blocks in which one
 * of the two Tickets is a Discovered Ticket it filed, until a User delegates, moves or dismisses it: its own waiting
 * Ticket may block any Ticket, or wait on any Ticket, delegated or running included.
 */
export async function addRelation(
  context: Context,
  caller: Caller,
  ticketId: string,
  input: RelationCreate,
): Promise<Relation> {
  return transaction(context.db, async (tx) => {
    const ticket = await findTicketRow(tx, caller, ticketId);
    if (!ticket) throw ticketNotFound();
    const other =
      "ticketId" in input
        ? await findTicketRef(tx, ticket.workspaceId, input.ticketId)
        : await findTicketRefByKey(tx, ticket.workspaceId, input.ticketKey);
    // A Ticket the caller can't read answers as if it weren't in the Workspace.
    const otherRow = other && (await findTicketRow(tx, caller, other.id));
    if (!other || !otherRow) throw unknownTicket();
    // A Relation shows on both Tickets, so it takes Write in both Projects.
    await requireWrite(tx, caller, ticket);
    await requireWrite(tx, caller, otherRow);
    if (other.id === ticket.id) throw new ApiError(400, "relation_to_itself", "A Ticket can't be related to itself.");
    let actor: ChangeActor;
    if (caller.kind === "user") {
      actor = caller.id;
    } else if (actsAsOwner(caller)) {
      // A Full token relates any two Tickets it has Write on, as its Owner would, outside any Run.
      actor = { kind: "agent", id: caller.id, runId: null };
    } else {
      const held = checkAgentRelation(caller, ticket, otherRow, input.kind);
      actor = await discoveringAgent(tx, caller, held);
    }
    const [from, to] = input.kind === "blockedBy" ? [other.id, ticket.id] : [ticket.id, other.id];
    if (input.kind !== "relatesTo" && (await blocksTransitively(tx, ticket.workspaceId, to, from))) {
      throw new ApiError(
        400,
        "blocking_cycle",
        "That block would form a cycle: the other Ticket already waits on this one.",
      );
    }
    const { rows } = await tx.query<{ id: string }>(
      `insert into relations (workspace_id, kind, ticket_id, other_ticket_id, created_by, created_by_agent_id, created_at)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (kind, least(ticket_id, other_ticket_id), greatest(ticket_id, other_ticket_id)) do nothing
       returning id`,
      [
        ticket.workspaceId,
        storedKind[input.kind],
        from,
        to,
        caller.kind === "user" ? caller.id : null,
        caller.kind === "agent" ? caller.id : null,
        context.clock.now(),
      ],
    );
    if (!rows[0]) throw new ApiError(409, "relation_exists", "These Tickets already have that Relation.");
    const self = (await findTicketRef(tx, ticket.workspaceId, ticket.id))!;
    await recordRelationChanges(context, tx, ticket.workspaceId, actor, input.kind, self, other, "added");
    return { id: rows[0]!.id, kind: input.kind, ticket: other };
  });
}

/** The close-as-duplicate route's body: the original, by its id or its key. */
export const DuplicateClose = Type.Union([
  Type.Object({ ticketId: Type.String({ description: "The original: the Ticket that carries the work." }) }),
  Type.Object({
    ticketKey: Type.String({ description: "The original's key, such as `CRONK-12`, matched ignoring case." }),
  }),
]);
export type DuplicateClose = Static<typeof DuplicateClose>;

/**
 * Closes the Ticket as a duplicate of another Ticket of its Workspace, the original: relates the two as
 * `duplicateOf` and `duplicatedBy` and moves the Ticket to its Project's first Canceled Status, stopping its running
 * Run, in one transaction. A User's act, or a Full token's as its Owner's; any other Agent gets `full_token_needed`,
 * as for entering Canceled. Needs Write in both Projects. Refused for a Ticket already finished
 * (`ticket_finished`), the Ticket itself (`relation_to_itself`) and an original that is itself closed as a duplicate
 * (`original_is_duplicate`), which names the Ticket to use instead.
 */
export async function closeAsDuplicate(
  context: Context,
  caller: Caller,
  ticketId: string,
  input: DuplicateClose,
): Promise<Ticket> {
  requireOwnerAct(caller, {
    act: "closing a Ticket as a duplicate",
    rule: "Closing a Ticket as a duplicate moves it to Canceled, which Agents never enter.",
  });
  return transaction(context.db, async (tx) => {
    const ticket = await findTicketRow(tx, caller, ticketId, { lock: true });
    if (!ticket) throw ticketNotFound();
    const original =
      "ticketId" in input
        ? await findTicketRef(tx, ticket.workspaceId, input.ticketId)
        : await findTicketRefByKey(tx, ticket.workspaceId, input.ticketKey);
    // A Ticket the caller can't read answers as if it weren't in the Workspace.
    const originalRow = original && (await findTicketRow(tx, caller, original.id));
    if (!original || !originalRow) throw unknownTicket();
    await requireWrite(tx, caller, ticket);
    await requireWrite(tx, caller, originalRow);
    if (original.id === ticket.id) {
      throw new ApiError(400, "relation_to_itself", "A Ticket can't be a duplicate of itself.");
    }
    const statuses = await statusesOf(tx, ticket.projectId);
    const kind = statuses.find((s) => s.id === ticket.statusId)?.kind;
    if (kind === "done" || kind === "canceled") {
      throw new ApiError(409, "ticket_finished", `${ticket.key} is already finished, so it isn't closed as a duplicate.`, {
        rule: "Only an unfinished Ticket is closed as a duplicate: a Done or Canceled one is finished already.",
        advice: `Relate ${ticket.key} to ${original.key} instead.`,
      });
    }
    const { rows: closedAs } = await tx.query<{ key: string }>(
      `select projects.key || '-' || tickets.number as key
       from relations join tickets on tickets.id = relations.other_ticket_id
       join projects on projects.id = tickets.project_id
       where relations.kind = 'duplicates' and relations.ticket_id = $1`,
      [original.id],
    );
    if (closedAs[0]) {
      throw new ApiError(
        400,
        "original_is_duplicate",
        `${original.key} is itself closed as a duplicate of ${closedAs[0].key}.`,
        {
          rule: "A duplicate names the Ticket that carries the work, never another duplicate.",
          advice: `Close ${ticket.key} as a duplicate of ${closedAs[0].key} instead.`,
        },
      );
    }
    const canceled = statuses.find((s) => s.kind === "canceled");
    if (!canceled) throw new ApiError(409, "no_canceled_status", `${ticket.key}'s Project has no Canceled Status.`);
    const actor: ChangeActor = caller.kind === "user" ? caller.id : { kind: "agent", id: caller.id, runId: null };
    const { rows } = await tx.query<{ id: string }>(
      `insert into relations (workspace_id, kind, ticket_id, other_ticket_id, created_by, created_by_agent_id, created_at)
       values ($1, 'duplicates', $2, $3, $4, $5, $6)
       on conflict (kind, least(ticket_id, other_ticket_id), greatest(ticket_id, other_ticket_id)) do nothing
       returning id`,
      [
        ticket.workspaceId,
        ticket.id,
        original.id,
        caller.kind === "user" ? caller.id : null,
        caller.kind === "agent" ? caller.id : null,
        context.clock.now(),
      ],
    );
    // The other way round was refused above, as the original would be a duplicate; this one can't be open with it.
    if (!rows[0]) throw new ApiError(409, "relation_exists", "These Tickets already have that Relation.");
    const self = (await findTicketRef(tx, ticket.workspaceId, ticket.id))!;
    await recordRelationChanges(context, tx, ticket.workspaceId, actor, "duplicateOf", self, original, "added");
    return editTicketIn(context, tx, caller, ticket.id, { statusId: canceled.id });
  });
}

/**
 * Refuses an Agent's Relation unless it is a block in which the Agent holds one of the two Tickets: a Discovered
 * Ticket it filed that still waits for a User. Answers the held Ticket, the blocked one when it holds both, whose Run
 * the Change records.
 */
function checkAgentRelation(agent: AgentCaller, ticket: TicketRow, other: TicketRow, kind: AddedRelationKind): TicketRow {
  const [blocker, blocked] = kind === "blockedBy" ? [other, ticket] : [ticket, other];
  const held = [blocked, blocker].find((t) => holdsDiscoveredTicket(agent, t));
  if (!held) {
    throw new ApiError(
      403,
      "not_your_discovered_ticket",
      `Neither ${ticket.key} nor ${other.key} is a Discovered Ticket ${agent.name} filed that still waits for a User.`,
      {
        rule:
          "An Agent adds a block only where one of its two Tickets is a Discovered Ticket the Agent filed, until a " +
          "User delegates, moves or dismisses it: its own Ticket may block any Ticket, or be blocked by any Ticket. " +
          "Other Relations are for Users.",
        advice: `Leave a Comment on ${ticket.key} asking ${ownerName(agent)}, ${agent.name}'s Owner, to relate it.`,
      },
    );
  }
  if (kind === "relatesTo") {
    throw new ApiError(403, "agent_adds_only_blocks", `${agent.name} is an Agent, and Agents add only blocks.`, {
      rule:
        "An Agent adds blocks to or from a Discovered Ticket it filed, until a User takes it up; other Relations are " +
        "for Users.",
      advice: `Add \`blocks\` or \`blockedBy\` between ${held.key} and the other Ticket, or leave a Comment instead.`,
    });
  }
  return held;
}

/**
 * How a Relation is stored: a block always from the blocking Ticket to the blocked one, a duplicate from the
 * duplicate to its original.
 */
type StoredKind = "blocks" | "relates" | "duplicates";
const storedKind: Record<RelationKind, StoredKind> = {
  blocks: "blocks",
  blockedBy: "blocks",
  relatesTo: "relates",
  duplicateOf: "duplicates",
  duplicatedBy: "duplicates",
};
/** A stored Relation as seen from its `ticket_id` side. */
const kindFromTicket: Record<StoredKind, RelationKind> = { blocks: "blocks", relates: "relatesTo", duplicates: "duplicateOf" };

function relationNotFound(): ApiError {
  return new ApiError(404, "not_found", "This Ticket has no such Relation.");
}

/**
 * Removes a Relation of the Ticket, whichever of its two Tickets it was made from: a User's act, or a Full token's
 * as its Owner's (the route refuses other Agents), recorded with the Agent and no Run.
 */
export async function removeRelation(
  context: Context,
  caller: Caller,
  ticketId: string,
  relationId: string,
): Promise<void> {
  await transaction(context.db, async (tx) => {
    const ticket = await findTicketRow(tx, caller, ticketId);
    if (!ticket) throw ticketNotFound();
    if (!isUuid(relationId)) throw relationNotFound();
    const { rows } = await tx.query<{ kind: StoredKind; ticketId: string; otherTicketId: string }>(
      `delete from relations where id = $1 and $2 in (ticket_id, other_ticket_id)
       returning kind, ticket_id as "ticketId", other_ticket_id as "otherTicketId"`,
      [relationId, ticket.id],
    );
    const removed = rows[0];
    if (!removed) throw relationNotFound();
    // A Relation with a Ticket the User can't read isn't listed for them, so it answers as if it didn't exist.
    const otherId = removed.ticketId === ticket.id ? removed.otherTicketId : removed.ticketId;
    const otherRow = await findTicketRow(tx, caller, otherId);
    if (!otherRow) throw relationNotFound();
    await requireWrite(tx, caller, ticket);
    await requireWrite(tx, caller, otherRow);
    const from = (await findTicketRef(tx, ticket.workspaceId, removed.ticketId))!;
    const to = (await findTicketRef(tx, ticket.workspaceId, removed.otherTicketId))!;
    const kind = kindFromTicket[removed.kind];
    const actor: ChangeActor = caller.kind === "user" ? caller.id : { kind: "agent", id: caller.id, runId: null };
    await recordRelationChanges(context, tx, ticket.workspaceId, actor, kind, from, to, "removed");
    if (removed.kind === "blocks") await blockingChanged(context, tx, [], [removed.otherTicketId]);
  });
}

const opposite: Record<RelationKind, RelationKind> = {
  blocks: "blockedBy",
  blockedBy: "blocks",
  relatesTo: "relatesTo",
  duplicateOf: "duplicatedBy",
  duplicatedBy: "duplicateOf",
};

/**
 * Records a Relation added or removed on both its Tickets' timelines, each naming the other Ticket, and tells
 * the Workspace's live streams both Tickets changed.
 */
export async function recordRelationChanges(
  { clock, live }: Context,
  tx: Tx,
  workspaceId: string,
  actor: ChangeActor,
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
    await recordChanges(tx, { id: one.id, workspaceId }, actor, at, [change(field, otherOne)]);
    live.publish(tx, workspaceId, { type: "ticket.changed", projectId: one.projectId, ticketId: one.id });
  }
}

/**
 * Whether one Ticket blocks another, directly or through others. Holds the Workspace's blocks still until the
 * transaction ends, so two blocks made at once can't close a cycle between them.
 */
export async function blocksTransitively(tx: Tx, workspaceId: string, blocker: string, blocked: string): Promise<boolean> {
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

/**
 * The Ticket's parent, Sub-Tickets and Relations, leaving out the Tickets the Viewer can't read, as if they didn't
 * exist. Its parent and Sub-Tickets are of its own Project, so the Viewer reads them whenever it reads the Ticket.
 */
export async function relationsOf(db: Db, viewer: Viewer, ticketId: string): Promise<TicketRelations> {
  const ticket = await findTicketRow(db, viewer, ticketId);
  if (!ticket) throw ticketNotFound();
  const reach = inReach(viewer, { project: "others.project_id", workspace: "others.workspace_id" }, "$2");
  const { rows } = await db.query<Relation>(
    `select relations.id,
       case when relations.kind = 'relates' then 'relatesTo'
            when relations.kind = 'blocks' and relations.ticket_id = $1 then 'blocks'
            when relations.kind = 'blocks' then 'blockedBy'
            when relations.ticket_id = $1 then 'duplicateOf' else 'duplicatedBy' end as kind,
       ${ticketRefColumn("others", "projects")} as ticket
     from relations
     join tickets others on others.id =
       case when relations.ticket_id = $1 then relations.other_ticket_id else relations.ticket_id end
     join projects on projects.id = others.project_id
     where $1 in (relations.ticket_id, relations.other_ticket_id) and ${reach.sql}
     order by relations.seq`,
    [ticket.id, reach.value],
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
