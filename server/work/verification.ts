import type { Context } from "../context.js";
import { transaction, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { userViewer } from "../identity/viewers.js";
import type { User } from "../identity/user.js";
import { startRunIfNeeded } from "../runs/runs.js";
import { recordChanges } from "./changes.js";
import { insertComment } from "./comment-writes.js";
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
    const ticket = await unverifiedTicket(tx, user, ticketId, "Accepted");
    await tx.query("update tickets set verification = 'verified' where id = $1", [ticket.id]);
    await recordChanges(tx, ticket, user.id, clock.now(), [{ field: "verification", from: "unverified", to: "verified" }]);
    live.publish(tx, ticket.workspaceId, { type: "ticket.changed", projectId: ticket.projectId, ticketId: ticket.id });
  });
  return (await findTicket(db, userViewer(user.id), ticketId))!;
}

/**
 * A User Reopens an Unverified Ticket with a Comment saying why: it goes back to the Status of the Step
 * that completed it, no longer Unverified, and gets a new Run there. It blocks again what it blocked.
 * A Ticket completed by work no Step produced, such as a merge of a Pull Request a User opened, stays
 * where it is, no longer Unverified, for the User to move.
 */
export async function reopenTicket(context: Context, user: User, ticketId: string, comment: string): Promise<Ticket> {
  const { db, clock, live } = context;
  await transaction(db, async (tx) => {
    const ticket = await unverifiedTicket(tx, user, ticketId, "Reopened");
    // Holds the board still until the move commits, so the Status it goes back to can't be removed meanwhile.
    await tx.query("select 1 from projects where id = $1 for share", [ticket.projectId]);
    const { rows } = await tx.query<{
      from: { id: string; name: string };
      to: { id: string; name: string } | null;
      withoutStep: boolean;
    }>(
      `select json_build_object('id', current.id, 'name', current.name) as from,
         case when back.id is null then null else json_build_object('id', back.id, 'name', back.name) end as to,
         tickets.completed_without_step as "withoutStep"
       from tickets join statuses current on current.id = tickets.status_id
       left join statuses back on back.id = tickets.completed_from_status_id
       where tickets.id = $1`,
      [ticket.id],
    );
    const { from, withoutStep } = rows[0]!;
    const to = rows[0]!.to ?? (withoutStep ? from : null);
    if (!to) {
      throw new ApiError(
        409,
        "reopen_status_gone",
        `The Status of the Step that completed ${ticket.key} has been removed, so Reopen has nowhere to send it. ` +
          "Accept it, then move it where it should go.",
      );
    }
    const now = clock.now();
    await tx.query(
      `update tickets set status_id = $2,
         status_entered_at = case when status_id = $2 then status_entered_at else $3 end,
         verification = null, completed_from_status_id = null, completed_without_step = false
       where id = $1`,
      [ticket.id, to.id, now],
    );
    await tx.query("delete from needs_you where ticket_id = $1", [ticket.id]);
    // Sent back by a User, like a move by hand, it starts its rounds afresh.
    await tx.query("delete from round_counts where ticket_id = $1", [ticket.id]);
    await insertComment(context, tx, ticket, { kind: "user", id: user.id }, comment, null);
    await recordChanges(tx, ticket, user.id, now, [
      ...(to.id === from.id ? [] : [{ field: "status" as const, from, to }]),
      { field: "verification", from: "unverified", to: null },
    ]);
    live.publish(tx, ticket.workspaceId, { type: "ticket.changed", projectId: ticket.projectId, ticketId: ticket.id });
    await startRunIfNeeded(context, tx, ticket.id, now);
  });
  return (await findTicket(db, userViewer(user.id), ticketId))!;
}

/** The Ticket, locked, if it is Unverified; otherwise a refusal saying it can't be Accepted or Reopened. */
async function unverifiedTicket(
  tx: Tx,
  user: User,
  ticketId: string,
  action: "Accepted" | "Reopened",
): Promise<TicketRow> {
  const ticket = await findTicketRow(tx, userViewer(user.id), ticketId, { lock: true });
  if (!ticket) throw ticketNotFound();
  if (ticket.verification !== "unverified") {
    throw new ApiError(
      409,
      "not_unverified",
      `${ticket.key} isn't Unverified: only a Ticket a Run completed, before anyone Accepts or Reopens it, can be ${action}.`,
    );
  }
  return ticket;
}
