import type { Context } from "../context.js";
import { transaction, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { userViewer } from "../identity/viewers.js";
import type { User } from "../identity/user.js";
import { startRunIfNeeded } from "../runs/runs.js";
import { recordChanges } from "./changes.js";
import { writeComment } from "./comments.js";
import { findTicket, findTicketRow, ticketNotFound, type Ticket, type TicketRow } from "./tickets.js";

/**
 * Verification: a User's judgement on a Ticket a Run completed. It stays Unverified, in its Done Status,
 * until a User Accepts it (Verified) or Reopens it with a Comment saying why, which sends it back to the
 * Status of the Step that completed it.
 */

/** A User Accepts an Unverified Ticket: it stays where it is, Verified. */
export async function acceptTicket(context: Context, user: User, ticketId: string): Promise<Ticket> {
  const { db, clock, live } = context;
  await transaction(db, async (tx) => {
    const ticket = await unverifiedTicket(tx, user, ticketId, "Accept");
    await tx.query("update tickets set verification = 'verified' where id = $1", [ticket.id]);
    await recordChanges(tx, ticket, user.id, clock.now(), [{ field: "verification", from: "unverified", to: "verified" }]);
    live.publish(tx, ticket.workspaceId, { type: "ticket.changed", projectId: ticket.projectId, ticketId: ticket.id });
  });
  return (await findTicket(db, userViewer(user.id), ticketId))!;
}

/**
 * A User Reopens an Unverified Ticket with a Comment saying why: it goes back to the Status of the Step
 * that completed it, no longer Unverified, and gets a new Run there. It blocks again what it blocked.
 */
export async function reopenTicket(context: Context, user: User, ticketId: string, comment: string): Promise<Ticket> {
  const { db, clock, live } = context;
  await transaction(db, async (tx) => {
    const ticket = await unverifiedTicket(tx, user, ticketId, "Reopen");
    const { rows } = await tx.query<{ from: { id: string; name: string }; to: { id: string; name: string } | null }>(
      `select json_build_object('id', current.id, 'name', current.name) as from,
         case when back.id is null then null else json_build_object('id', back.id, 'name', back.name) end as to
       from tickets join statuses current on current.id = tickets.status_id
       left join statuses back on back.id = tickets.completed_from_status_id
       where tickets.id = $1`,
      [ticket.id],
    );
    const { from, to } = rows[0]!;
    if (!to) {
      throw new ApiError(
        409,
        "reopen_status_gone",
        `The Status of the Step that completed ${ticket.key} has been removed, so Reopen has nowhere to send it. ` +
          "Accept it, then move it where it should go.",
      );
    }
    await tx.query("select 1 from projects where id = $1 for share", [ticket.projectId]);
    await tx.query(
      "update tickets set status_id = $2, verification = null, completed_from_status_id = null where id = $1",
      [ticket.id, to.id],
    );
    const now = clock.now();
    await writeComment(context, tx, { kind: "user", ...user }, ticket, { body: comment });
    await recordChanges(tx, ticket, user.id, now, [
      { field: "status", from, to },
      { field: "verification", from: "unverified", to: null },
    ]);
    live.publish(tx, ticket.workspaceId, { type: "ticket.changed", projectId: ticket.projectId, ticketId: ticket.id });
    await startRunIfNeeded(context, tx, ticket.id, now);
  });
  return (await findTicket(db, userViewer(user.id), ticketId))!;
}

/** The Ticket, locked, if it is Unverified; otherwise a refusal naming the action. */
async function unverifiedTicket(tx: Tx, user: User, ticketId: string, action: string): Promise<TicketRow> {
  const ticket = await findTicketRow(tx, userViewer(user.id), ticketId, { lock: true });
  if (!ticket) throw ticketNotFound();
  if (ticket.verification !== "unverified") {
    throw new ApiError(
      409,
      "not_unverified",
      `${ticket.key} isn't Unverified: only a Ticket a Run completed, before anyone Accepts or Reopens it, can be ${
        action === "Accept" ? "Accepted" : "Reopened"
      }.`,
    );
  }
  return ticket;
}
