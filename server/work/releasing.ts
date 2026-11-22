import type { Context } from "../context.js";
import type { Db, Tx } from "../db.js";
import { userName } from "../identity/user.js";
import { startRunIfNeeded, stopRunningRun } from "../runs/runs.js";
import { recordChanges } from "./changes.js";

/**
 * Where a User lets go of their Tickets: a whole Workspace when they leave it, or one Project of it when they lose
 * Write there.
 */
export interface Releasing {
  workspaceId: string;
  userId: string;
  /** The one Project, or null for every Project of the Workspace. */
  projectId: string | null;
}

interface Held {
  id: string;
  projectId: string;
  assignee: { id: string; name: string } | null;
  delegate: { id: string; name: string } | null;
}

/** The Tickets the User is Assignee of there, or that are delegated to their Agents. */
async function heldBy(db: Db | Tx, { workspaceId, userId, projectId }: Releasing, { lock }: { lock: boolean }): Promise<Held[]> {
  const { rows } = await db.query<Held>(
    `select tickets.id, tickets.project_id as "projectId",
       case when tickets.assignee_id = $2 then json_build_object('id', users.id, 'name', ${userName()}) end as assignee,
       case when agents.owner_id = $2 then json_build_object('id', agents.id, 'name', agents.name) end as delegate
     from tickets left join users on users.id = tickets.assignee_id
     left join agents on agents.id = tickets.delegate_id
     where tickets.workspace_id = $1 and (tickets.assignee_id = $2 or agents.owner_id = $2)
       and ($3::uuid is null or tickets.project_id = $3)
     order by tickets.id ${lock ? "for update of tickets" : ""}`,
    [workspaceId, userId, projectId],
  );
  return rows;
}

/** How many Tickets {@link releaseTickets} would unassign or undelegate, read without changing anything. */
export async function countHeld(db: Db | Tx, releasing: Releasing): Promise<number> {
  return (await heldBy(db, releasing, { lock: false })).length;
}

/**
 * Takes the User off their Tickets there, and their Agents off those delegated to them: a running Run is stopped with
 * `reason`, and the Admin's Changes record the Assignee and Delegate taken away. Tickets left without an Assignee wait
 * in every Admin's Inbox until someone assigns them. Returns how many Tickets it changed.
 */
export async function releaseTickets(
  context: Context,
  tx: Tx,
  adminId: string,
  releasing: Releasing,
  reason: string,
  now: Date,
): Promise<number> {
  const { workspaceId, userId } = releasing;
  const tickets = await heldBy(tx, releasing, { lock: true });
  for (const ticket of tickets) {
    if (ticket.delegate) await stopRunningRun(context, tx, ticket.id, reason, now);
    await tx.query(
      `update tickets set assignee_id = case when $2 then null else assignee_id end,
         former_assignee_id = case when $2 then $4::uuid else former_assignee_id end,
         delegate_id = case when $3 then null else delegate_id end where id = $1`,
      [ticket.id, ticket.assignee !== null, ticket.delegate !== null, userId],
    );
    await recordChanges(tx, { id: ticket.id, workspaceId }, adminId, now, [
      ...(ticket.assignee ? [{ field: "assignee" as const, from: ticket.assignee, to: null }] : []),
      ...(ticket.delegate ? [{ field: "delegate" as const, from: ticket.delegate, to: null }] : []),
    ]);
    // Losing its Delegate ends a Ticket's wait for a Run.
    if (ticket.delegate) await startRunIfNeeded(context, tx, ticket.id, now);
    context.live.publish(tx, workspaceId, { type: "ticket.changed", projectId: ticket.projectId, ticketId: ticket.id });
  }
  return tickets.length;
}

/** How Cronk names a User in what it writes, as `userName` says. */
export async function nameOf(tx: Db | Tx, userId: string): Promise<string> {
  const { rows } = await tx.query<{ name: string }>(`select ${userName()} as name from users where id = $1`, [userId]);
  return rows[0]!.name;
}
