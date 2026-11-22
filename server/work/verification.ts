import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { transaction, type Db, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { requireWrite, userViewer, type Viewer } from "../identity/viewers.js";
import type { User } from "../identity/user.js";
import { startRunIfNeeded, blockingChanged } from "../runs/runs.js";
import { insertComment } from "./comment-writes.js";
import { writeTicket } from "./ticket-writes.js";
import { findTicket, findTicketRow, ticketNotFound, type Ticket, type TicketRow } from "./tickets.js";

/**
 * Verification: a User's judgement on a Ticket a Run completed. It stays Unverified, in its Done Status,
 * until a User Accepts it (Verified) or Reopens it with a Comment saying why, which sends it back to the
 * Status of the Step that completed it.
 */

/** A User Accepts an Unverified Ticket: it stays where it is, Verified. */
export async function acceptTicket(context: Context, user: User, ticketId: string): Promise<Ticket> {
  const { db, clock } = context;
  await transaction(db, async (tx) => {
    const ticket = await unverifiedTicket(tx, user, ticketId, "Accepted");
    await writeTicket(context, tx, ticket, user.id, { verification: "verified" }, { at: clock.now() });
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
  const { db, clock } = context;
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
    // Sent back by a User, like a move by hand, it starts its rounds afresh.
    await tx.query("delete from round_counts where ticket_id = $1", [ticket.id]);
    await insertComment(context, tx, ticket, { kind: "user", id: user.id }, comment, null);
    // Its Status's Changes come after the Comment saying why, and clearing `verification` forgets where it came from.
    await writeTicket(
      context,
      tx,
      ticket,
      user.id,
      { statusId: to.id, verification: null, completedWithoutStep: false },
      { at: now },
    );
    await startRunIfNeeded(context, tx, ticket.id, now);
    // Sent back out of Done, it blocks again what it blocks.
    await blockingChanged(context, tx, [ticket.id]);
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
  await requireWrite(tx, userViewer(user.id), ticket);
  if (ticket.verification !== "unverified") {
    throw new ApiError(
      409,
      "not_unverified",
      `${ticket.key} isn't Unverified: only a Ticket a Run completed, before anyone Accepts or Reopens it, can be ${action}.`,
    );
  }
  return ticket;
}

const StatusRef = Type.Object({ id: Type.String({ format: "uuid" }), name: Type.String() });

/** What completed a Ticket, and what Reopen would do with it while it is Unverified. */
export const Completion = Type.Object({
  merge: Type.Union(
    [
      Type.Object({
        pullRequest: Type.Object({
          id: Type.Integer({ description: "GitHub's id for the Pull Request." }),
          repository: Type.String(),
          number: Type.Integer(),
          title: Type.String(),
          url: Type.String(),
        }),
        mergedBy: Type.Union([Type.String(), Type.Null()], {
          description: "The login of the GitHub account that merged it; null when GitHub named none.",
        }),
      }),
      Type.Null(),
    ],
    { description: "The merged Pull Request that completed the Ticket; null when a Run's Step completed it." },
  ),
  reopen: Type.Union(
    [
      Type.Object({ kind: Type.Literal("back"), status: StatusRef }, {
        description: "Reopen sends it back to this Status: of the Step that completed it, or that produced the merged Pull Request.",
      }),
      Type.Object({ kind: Type.Literal("stays") }, { description: "No Step produced the work, so Reopen leaves it where it is." }),
      Type.Object({ kind: Type.Literal("refused") }, {
        description: "The Status Reopen would send it back to has been removed, so Reopen is refused.",
      }),
    ],
    { description: "Where Reopen sends the Ticket." },
  ),
});
export type Completion = Static<typeof Completion>;

/** What completed the Ticket and where Reopen sends it; null for a Ticket nothing completed, or that has moved on since. */
export async function completionOf(db: Db, viewer: Viewer, ticketId: string): Promise<Completion | null> {
  const ticket = await findTicketRow(db, viewer, ticketId);
  if (!ticket) throw ticketNotFound();
  if (ticket.verification === null) return null;
  const { rows } = await db.query<{ merge: Completion["merge"]; back: { id: string; name: string } | null; withoutStep: boolean }>(
    `select case when pull_requests.id is null then null else json_build_object(
         'pullRequest', json_build_object('id', pull_requests.id, 'repository', pull_requests.repository_full_name,
           'number', pull_requests.number, 'title', pull_requests.title, 'url', pull_requests.url),
         'mergedBy', pull_requests.merged_by_login) end as merge,
       case when back.id is null then null else json_build_object('id', back.id, 'name', back.name) end as back,
       tickets.completed_without_step as "withoutStep"
     from tickets
     left join pull_requests on pull_requests.id = tickets.completed_by_pull_request_id
     left join statuses back on back.id = tickets.completed_from_status_id
     where tickets.id = $1`,
    [ticket.id],
  );
  const { merge, back, withoutStep } = rows[0]!;
  return {
    merge,
    reopen: back ? { kind: "back", status: back } : withoutStep ? { kind: "stays" } : { kind: "refused" },
  };
}
