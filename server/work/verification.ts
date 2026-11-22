import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { transaction, type Db, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { accessIn, inReach, requireWrite, userViewer, type Viewer } from "../identity/viewers.js";
import { userName, type User } from "../identity/user.js";
import { startRunIfNeeded, blockingChanged, stopRunningRun } from "../runs/runs.js";
import { insertComment } from "./comment-writes.js";
import { markdown } from "./fields.js";
import { lockTickets, writeTicket } from "./ticket-writes.js";
import { findTicket, findTicketRow, ticketNotFound, TicketRef, ticketRefColumn, type Ticket, type TicketRow } from "./tickets.js";

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

/** The reopen route's body. */
export const TicketReopen = Type.Object({
  comment: markdown(100_000, "Why it is reopened, in Markdown; added to the Ticket's Comments."),
  sendBack: Type.Optional(
    Type.Array(Type.String({ format: "uuid" }), {
      maxItems: 1000,
      description:
        "The ids of the dependents to send back to their Project's first Backlog Status, stopping any running Run: each " +
        "one `reopen-preview` lists, in a Project where the User has Write. The others are left where they are. None " +
        "when left out.",
    }),
  ),
});
export type TicketReopen = Static<typeof TicketReopen>;

/**
 * A User Reopens an Unverified Ticket with a Comment saying why: it goes back to the Status of the Step
 * that completed it, no longer Unverified, and gets a new Run there. It blocks again what it blocked.
 * A Ticket completed by work no Step produced, such as a merge of a Pull Request a User opened, stays
 * where it is, no longer Unverified, for the User to move.
 */
export async function reopenTicket(
  context: Context,
  user: User,
  ticketId: string,
  comment: string,
  sendBack: string[] = [],
): Promise<Ticket> {
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
    // Read before the move, while its Status still says when it was completed.
    const movedOn = await dependentsMovedOn(tx, userViewer(user.id), ticket.id);
    // Every dependent to send back is checked before anything changes, so a refusal leaves everything as it was.
    const toSendBack = new Set(sendBack);
    for (const id of toSendBack) {
      const dependent = movedOn.find((d) => d.ticket.id === id);
      if (!dependent) {
        throw new ApiError(
          400,
          "not_in_preview",
          `Only a Ticket ${ticket.key} blocks that moved on since it was completed, as \`reopen-preview\` lists it, can be sent back.`,
        );
      }
      await requireWrite(tx, userViewer(user.id), dependent.ticket);
    }
    const now = clock.now();
    // Sent back by a User, like a move by hand, it starts its rounds afresh.
    await tx.query("delete from round_counts where ticket_id = $1", [ticket.id]);
    await insertComment(context, tx, ticket, { kind: "user", id: user.id }, comment, null);
    const backlogs = await firstBacklogs(tx, movedOn.filter((d) => toSendBack.has(d.ticket.id)).map((d) => d.ticket.projectId));
    const locked = new Map((await lockTickets(tx, [...toSendBack])).map((row) => [row.id, row]));
    const who = toSendBack.size > 0 ? await nameOf(tx, user.id) : "";
    for (const dependent of movedOn) {
      const row = locked.get(dependent.ticket.id);
      const backlog = row ? backlogs.get(row.projectId)! : null;
      await insertComment(
        context,
        tx,
        dependent.ticket,
        { kind: "cronk" },
        reopenedNotice(ticket.key, comment, backlog?.name ?? null),
        null,
      );
      if (!row || !backlog) continue;
      // Sent back like a move by hand: its Run stops, it starts its rounds afresh, and it still waits on the reopened one.
      await stopRunningRun(context, tx, row.id, `${who} sent ${dependent.ticket.key} back to ${backlog.name}, Reopening ${ticket.key}.`, now);
      await writeTicket(context, tx, row, user.id, { statusId: backlog.id }, { at: now });
      await tx.query("delete from round_counts where ticket_id = $1", [row.id]);
    }
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
    // Sent back out of Done, it blocks again what it blocks; a dependent sent back waits for it again.
    await blockingChanged(context, tx, [ticket.id]);
    for (const id of locked.keys()) await startRunIfNeeded(context, tx, id, now);
  });
  return (await findTicket(db, userViewer(user.id), ticketId))!;
}

/**
 * What Cronk writes on a dependent that moved on when the Ticket it builds on is Reopened: names that Ticket, so
 * the Mention links it, and quotes the reason.
 */
export function reopenedNotice(reopenedKey: string, reason: string, sentBackTo: string | null): string {
  const quoted = reason
    .trim()
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
  const choice = sentBackTo
    ? `It was sent back to ${sentBackTo}, to wait until ${reopenedKey} is done again.`
    : "It was left where it is.";
  return `${reopenedKey}, which blocks this Ticket, was Reopened after this one moved on, so the work this one builds on may change:\n\n${quoted}\n\n${choice}`;
}

/** Each Project's first Backlog Status, by Project id. */
async function firstBacklogs(tx: Tx, projectIds: string[]): Promise<Map<string, { id: string; name: string }>> {
  if (projectIds.length === 0) return new Map();
  const { rows } = await tx.query<{ projectId: string; id: string; name: string }>(
    `select distinct on (project_id) project_id as "projectId", id, name from statuses
     where project_id = any($1::uuid[]) and kind = 'backlog' order by project_id, position`,
    [[...new Set(projectIds)]],
  );
  return new Map(rows.map(({ projectId, ...status }) => [projectId, status]));
}

/** How a stop reason names the User. */
async function nameOf(tx: Tx, userId: string): Promise<string> {
  const { rows } = await tx.query<{ name: string }>(`select ${userName()} as name from users where id = $1`, [userId]);
  return rows[0]!.name;
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

/** A Ticket the completed Ticket blocks that moved on since its completion, as Reopen lists it. */
export const MovedOnDependent = Type.Object({
  ticket: TicketRef,
  status: Type.Object({
    id: Type.String({ format: "uuid" }),
    name: Type.String(),
    kind: Type.Union([
      Type.Literal("backlog"),
      Type.Literal("active"),
      Type.Literal("review"),
      Type.Literal("done"),
      Type.Literal("canceled"),
    ]),
  }),
  running: Type.Boolean({ description: "Whether a Run is running on it." }),
  canWrite: Type.Boolean({ description: "Whether the caller has Write in its Project, so Reopen may send it back." }),
});
export type MovedOnDependent = Static<typeof MovedOnDependent>;

export const ReopenPreview = Type.Object({
  dependents: Type.Array(MovedOnDependent, {
    description:
      "The Tickets it blocks that moved on since it was completed: they left a Backlog Status, or had a Run start, then " +
      "or later. Only those the caller may read; by key. Empty for a Ticket that isn't Unverified.",
  }),
});
export type ReopenPreview = Static<typeof ReopenPreview>;

/** What Reopening the Ticket would touch besides itself: the dependents that moved on since it was completed. */
export async function reopenPreview(db: Db, viewer: Viewer, ticketId: string): Promise<ReopenPreview> {
  const ticket = await findTicketRow(db, viewer, ticketId);
  if (!ticket) throw ticketNotFound();
  if (ticket.verification !== "unverified") return { dependents: [] };
  return { dependents: await dependentsMovedOn(db, viewer, ticket.id) };
}

/**
 * The Tickets an Unverified Ticket blocks, that the Viewer may read, which moved on since it was completed: a Change
 * out of a Backlog Status, or a Run started, at its completion or later. It was completed when it entered its Done
 * Status, which it can't leave by hand while Unverified. A Run starting at the completion itself counts, as one
 * waiting on it starts the moment it is completed.
 */
async function dependentsMovedOn(
  db: Db | Tx,
  viewer: Viewer,
  ticketId: string,
): Promise<(MovedOnDependent & { ticket: { workspaceId: string } })[]> {
  const place = { project: "dependent.project_id", workspace: "dependent.workspace_id" };
  const reach = inReach(viewer, place, "$2");
  const access = accessIn(viewer, place, "$3");
  const { rows } = await db.query<MovedOnDependent & { workspaceId: string }>(
    `select ${ticketRefColumn("dependent", "dependent_projects")} as ticket, dependent.workspace_id as "workspaceId",
       json_build_object('id', status.id, 'name', status.name, 'kind', status.kind) as status,
       exists (select 1 from runs where runs.ticket_id = dependent.id and runs.state = 'running') as running,
       (${access.sql}) = 'write' as "canWrite"
     from tickets completed
     join relations on relations.kind = 'blocks' and relations.ticket_id = completed.id
     join tickets dependent on dependent.id = relations.other_ticket_id
     join projects dependent_projects on dependent_projects.id = dependent.project_id
     join statuses status on status.id = dependent.status_id
     where completed.id = $1 and ${reach.sql}
       and (
         exists (select 1 from runs where runs.ticket_id = dependent.id and runs.started_at >= completed.status_entered_at)
         or exists (
           select 1 from changes join statuses left_status on left_status.id::text = changes.from_value ->> 'id'
           where changes.ticket_id = dependent.id and changes.field = 'status' and left_status.kind = 'backlog'
             and changes.at >= completed.status_entered_at
         )
       )
     order by dependent_projects.key, dependent.number`,
    [ticketId, reach.value, access.value],
  );
  return rows.map(({ workspaceId, ...dependent }) => ({ ...dependent, ticket: { ...dependent.ticket, workspaceId } }));
}
