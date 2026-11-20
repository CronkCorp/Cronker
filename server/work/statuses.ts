import type { Clock } from "../clock.js";
import type { Context } from "../context.js";
import { transaction, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { blockingChanged } from "../runs/runs.js";
import { userViewer } from "../identity/viewers.js";
import {
  findProject,
  insertStatus,
  projectNotFound,
  statusesOf,
  statusKinds,
  type Project,
  type StatusKind,
} from "./projects.js";
import { mayHaveStep, noStepWhy, outcomesOf, targetRefusal } from "./steps.js";

/**
 * Changes to a Project's Statuses. Each change is worked out on the whole board in
 * board order, checked against the rule that every Status kind keeps a Status, and
 * only then written, all under a lock on the Project so concurrent changes can't
 * together break the rule.
 */
export type StatusChange =
  | { type: "add"; name: string; kind: StatusKind; position?: number }
  | { type: "edit"; statusId: string; name?: string; kind?: StatusKind; position?: number }
  | { type: "remove"; statusId: string };

interface Draft {
  id?: string;
  name: string;
  kind: StatusKind;
}

const kindNames: Record<StatusKind, string> = {
  backlog: "Backlog",
  active: "Active",
  review: "Review",
  done: "Done",
  canceled: "Canceled",
};

export async function changeStatuses(
  context: Context,
  userId: string,
  projectId: string,
  change: StatusChange,
): Promise<Project> {
  const { db, clock, live } = context;
  return transaction(db, async (tx) => {
    const project = await findProject(tx, userViewer(userId), projectId, { lock: true });
    if (!project) throw projectNotFound();
    const { statuses } = project;

    const board: Draft[] = statuses.map((s) => ({ ...s }));
    let created: Draft | undefined;
    switch (change.type) {
      case "add": {
        created = { name: change.name.trim(), kind: change.kind };
        board.splice(checkPosition(change.position ?? board.length, board.length), 0, created);
        break;
      }
      case "edit": {
        const index = indexOf(board, change.statusId);
        const status = board[index]!;
        if (change.name !== undefined) status.name = change.name.trim();
        if (change.kind !== undefined) status.kind = change.kind;
        if (change.position !== undefined) {
          board.splice(index, 1);
          board.splice(checkPosition(change.position, board.length), 0, status);
        }
        break;
      }
      case "remove": {
        board.splice(indexOf(board, change.statusId), 1);
        break;
      }
    }

    checkNames(board);
    checkKinds(board, statuses);
    await checkNoTicketsIn(tx, project, board);
    await checkOutcomeTargets(tx, project, board);
    checkSteps(board, statuses);
    await write(tx, clock, project, board);
    if (change.type === "edit" && change.kind !== undefined) {
      // A Status's kind says whether its Tickets are finished, for what they block and for their parents.
      const { rows } = await tx.query<{ id: string }>("select id from tickets where status_id = $1", [change.statusId]);
      await blockingChanged(context, tx, rows.map((row) => row.id));
    }
    live.publish(tx, project.workspaceId, { type: "statuses.changed", projectId: project.id });
    return { ...project, statuses: await statusesOf(tx, project.id) };
  });
}

function indexOf(board: Draft[], statusId: string): number {
  const index = board.findIndex((s) => s.id === statusId);
  if (index < 0) throw new ApiError(404, "not_found", "No such Status in this Project.");
  return index;
}

function checkPosition(position: number, last: number): number {
  if (position < 0 || position > last) {
    throw new ApiError(400, "invalid_position", `A position on this board is from 0 to ${last}.`);
  }
  return position;
}

function checkNames(board: Draft[]): void {
  const seen = new Set<string>();
  for (const { name } of board) {
    if (seen.has(name.toLowerCase())) {
      throw new ApiError(409, "status_name_taken", `This Project already has a Status called ${name}.`);
    }
    seen.add(name.toLowerCase());
  }
}

/** A single change touches one Status, so a kind it empties had exactly one Status before. */
function checkKinds(board: Draft[], before: Draft[]): void {
  for (const kind of statusKinds) {
    if (board.some((s) => s.kind === kind)) continue;
    const last = before.find((s) => s.kind === kind)!;
    throw new ApiError(
      409,
      "status_kind_needed",
      `Every Project needs at least one ${kindNames[kind]} Status, and ${last.name} is this Project's only one. ` +
        `Add another ${kindNames[kind]} Status first.`,
    );
  }
}

/** A Status keeping its Step can't become Done or Canceled: Tickets there get no Runs. */
function checkSteps(board: Draft[], before: Project["statuses"]): void {
  for (const status of board) {
    if (mayHaveStep(status.kind) || !before.find((s) => s.id === status.id)?.step) continue;
    throw new ApiError(
      409,
      "step_on_done_or_canceled_status",
      `${status.name} has a Step, so it can't be a ${kindNames[status.kind]} Status: ${noStepWhy}. ` +
        `Remove ${status.name}'s Step first.`,
    );
  }
}

/**
 * Outcomes keep a Status to move Tickets to, of a kind they may move them to: a Status an
 * Outcome of another Status's Step targets can't go, nor become a kind that Outcome may not target.
 */
async function checkOutcomeTargets(tx: Tx, project: Project, board: Draft[]): Promise<void> {
  const named = (id: string) => project.statuses.find((s) => s.id === id)!.name;
  for (const outcome of await outcomesOf(tx, project.id)) {
    // A removed Status's Step goes with it.
    if (!board.some((s) => s.id === outcome.stepStatusId)) continue;
    const stepOn = named(outcome.stepStatusId);
    const target = board.find((s) => s.id === outcome.statusId);
    if (!target) {
      const name = named(outcome.statusId);
      throw new ApiError(
        409,
        "status_is_outcome_target",
        `${stepOn}'s Outcome ${outcome.name} moves Tickets to ${name}. ` +
          `Change that Outcome or remove ${stepOn}'s Step before removing ${name}.`,
      );
    }
    const refusal = targetRefusal(outcome, target.kind);
    if (refusal) {
      throw new ApiError(
        409,
        "outcome_target_not_allowed",
        `${stepOn}'s ${refusal.role} ${outcome.name} moves Tickets to ${target.name}, ` +
          `so ${target.name} can't be a ${refusal.kind} Status: ${refusal.why}.`,
      );
    }
  }
}

/** A Status holding Tickets can't go: they'd be left without a Status. */
async function checkNoTicketsIn(tx: Tx, project: Project, board: Draft[]): Promise<void> {
  const kept = board.flatMap((s) => (s.id ? [s.id] : []));
  const { rows: occupied } = await tx.query<{ name: string; ticketCount: number }>(
    `select statuses.name, count(*)::int as "ticketCount"
     from statuses join tickets on tickets.status_id = statuses.id
     where statuses.project_id = $1 and not (statuses.id = any($2::uuid[]))
     group by statuses.id, statuses.name`,
    [project.id, kept],
  );
  if (occupied[0]) {
    const { name, ticketCount } = occupied[0];
    throw new ApiError(
      409,
      "status_has_tickets",
      ticketCount === 1
        ? `${name} holds 1 Ticket. Move it to another Status before removing ${name}.`
        : `${name} holds ${ticketCount} Tickets. Move them to another Status before removing ${name}.`,
    );
  }
}

async function write(tx: Tx, clock: Clock, project: Project, board: Draft[]): Promise<void> {
  const kept = board.flatMap((s) => (s.id ? [s.id] : []));
  // Steps go with their Statuses; removed first, so no Outcome of theirs is left targeting a removed Status.
  await tx.query("delete from steps where project_id = $1 and not (status_id = any($2::uuid[]))", [project.id, kept]);
  await tx.query("delete from statuses where project_id = $1 and not (id = any($2::uuid[]))", [project.id, kept]);
  for (const [position, status] of board.entries()) {
    if (status.id) {
      await tx.query("update statuses set name = $2, kind = $3, position = $4 where id = $1", [
        status.id,
        status.name,
        status.kind,
        position,
      ]);
    } else {
      await insertStatus(tx, project, status, position, clock.now());
    }
  }
}
