import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { afterCommit, transaction, type Db, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import { slugColumn } from "../http/readable.js";
import type { AgentCaller, Caller } from "../identity/callers.js";
import { inReach, requireWrite, userViewer, type Viewer } from "../identity/viewers.js";
import { lockTickets, writeTicket } from "../work/ticket-writes.js";
import { statusesOf, type Status } from "../work/projects.js";
import { mayHaveStep, type LabelRule, type Step } from "../work/steps.js";
import { recordReport } from "../knowledge/reports.js";
import { findTicket, findTicketRefByKey, findTicketRow, ticketNotFound, type Ticket, type TicketRow } from "../work/tickets.js";
import { moveByCronk } from "../pipeline/cronk-moves.js";
import { sendBackOnEnteringReview } from "../pipeline/conflicts.js";
import { Brief, buildBrief, offeredOutcomes } from "./brief.js";
import { Cost } from "./costs.js";
import { isLocalOnly, type RunReports, type RunToStart, type StartResult } from "./runner.js";
import { askQuestion } from "./questions.js";
import { RunState, wentWrong } from "./states.js";
import { inArchivedProject, isBlocked, queueOrder } from "./waiting.js";
import { userName } from "../identity/user.js";
import { conflictResolved, joinQueueAutonomously, resolvingConflict, resolvingOutcome } from "../pipeline/merge-queue.js";
import { sessionIdOf } from "./session-ids.js";

/**
 * Runs: when a Ticket gets one, starting it through its Delegate's Runner, and ending it.
 * A delegated Ticket entering a Status with a Step gets a Run, unless it has a running one;
 * the Run ends when its Agent calls `finish` with an Outcome, when its Runner reports it ended
 * without finishing, when nothing names it for its Workspace's lost-Run threshold, or when a User
 * moves, undelegates or re-delegates its Ticket. Nothing starts a Run again after one went wrong
 * but a User's Retry.
 */

/** Who asked a Run's Question: its Agent, or Cronk itself. */
const QuestionBy = Type.Union([Type.Literal("agent"), Type.Literal("cronk")]);
type QuestionBy = Static<typeof QuestionBy>;

export const Run = Type.Object({
  id: Type.String({ format: "uuid" }),
  ticketId: Type.String({ format: "uuid" }),
  step: Type.Object(
    {
      statusId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], { description: "Null once the Status is removed." }),
      name: Type.String({ description: "The Status's name when the Run started." }),
    },
    { description: "The Step the Run is of, by the Status it sits on." },
  ),
  agent: Type.Object({ id: Type.String({ format: "uuid" }), name: Type.String() }),
  model: Type.String({ description: "The label of the model the Step wanted when the Run started." }),
  state: RunState,
  outcome: Type.Union([Type.String(), Type.Null()], { description: "The Outcome its Agent finished it with." }),
  question: Type.Union([Type.String(), Type.Null()], {
    description: "The Question it ended with, if any: its Agent's, or Cronk's own when its Step's round limit was reached.",
  }),
  questionBy: Type.Union([QuestionBy, Type.Null()], {
    description:
      "Who asked the Question: `agent`, its Agent, or `cronk`, when the Agent chose an Outcome counting as a round " +
      "once the Step's round limit was reached, so Cronk applied *needs you* instead.",
  }),
  endReason: Type.Union([Type.String(), Type.Null()], {
    description: "Why it failed, was lost or was stopped, or why its Runner refused to start it.",
  }),
  sessionUrl: Type.Union([Type.String(), Type.Null()], { description: "Where to follow the Run, such as its claude.ai session." }),
  cost: Type.Union([Cost, Type.Null()], {
    description:
      "What it cost, once it ended, where its Runner reports it: a Managed Agents session's cost at list prices. " +
      "Null while it runs and for Runners that report none, such as a subscription.",
  }),
  transcriptId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
    description: "Its Transcript, once one was uploaded for the session its Runner returned when starting it.",
  }),
  transcriptSlug: Type.Union([Type.String(), Type.Null()], {
    description: "Its Transcript's readable form, as the Transcript's address and the API take it; null without one.",
  }),
  transcriptDeleted: Type.Boolean({ description: "Whether a User deleted its Transcript." }),
  startedAt: Type.String({ format: "date-time" }),
  endedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  lastCallAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()], {
    description: "When, while it was running, its Agent last called Cronk naming the Run or its Ticket; null before its first call.",
  }),
});
export type Run = Static<typeof Run>;

type Row = Omit<Run, "startedAt" | "endedAt" | "lastCallAt"> & {
  startedAt: Date;
  endedAt: Date | null;
  lastCallAt: Date | null;
  workspaceId: string;
  agentId: string;
  statusId: string | null;
  brief: Brief;
};

const columns = `runs.id, runs.ticket_id as "ticketId",
  json_build_object('statusId', runs.status_id, 'name', runs.status_name) as step,
  json_build_object('id', agents.id, 'name', agents.name) as agent, runs.model, runs.state, runs.outcome,
  runs.question, runs.question_by as "questionBy", runs.end_reason as "endReason", runs.session_url as "sessionUrl",
  case when runs.cost_amount is not null
    then json_build_object('amount', runs.cost_amount, 'currency', runs.cost_currency) end as cost,
  (select transcripts.id from transcripts where transcripts.run_id = runs.id and transcripts.deleted_at is null limit 1)
    as "transcriptId",
  (select ${slugColumn("transcript", "transcripts.id", "agents.name")} from transcripts
    where transcripts.run_id = runs.id and transcripts.deleted_at is null limit 1) as "transcriptSlug",
  exists (select from transcripts where transcripts.run_id = runs.id and transcripts.deleted_at is not null)
    as "transcriptDeleted",
  runs.started_at as "startedAt", runs.ended_at as "endedAt", runs.last_call_at as "lastCallAt",
  runs.workspace_id as "workspaceId", runs.agent_id as "agentId", runs.status_id as "statusId", runs.brief`;

const present = ({ startedAt, endedAt, lastCallAt, workspaceId: _w, agentId: _a, statusId: _s, brief: _b, ...row }: Row): Run => ({
  ...row,
  startedAt: startedAt.toISOString(),
  endedAt: endedAt?.toISOString() ?? null,
  lastCallAt: lastCallAt?.toISOString() ?? null,
});

export function runNotFound(): ApiError {
  return new ApiError(404, "not_found", "No such Run.");
}

/** A Ticket's Runs, oldest first. */
export async function runsOf(db: Db, viewer: Viewer, ticketId: string): Promise<Run[]> {
  const ticket = await findTicketRow(db, viewer, ticketId);
  if (!ticket) throw ticketNotFound();
  const { rows } = await db.query<Row>(
    `select ${columns} from runs join agents on agents.id = runs.agent_id where runs.ticket_id = $1 order by runs.seq`,
    [ticket.id],
  );
  return rows.map(present);
}

async function findRunRow(db: Db | Tx, viewer: Viewer, runId: string, { lock = false } = {}): Promise<Row | undefined> {
  if (!isUuid(runId)) return undefined;
  const view = inReach(
    viewer,
    { project: "(select run_tickets.project_id from tickets run_tickets where run_tickets.id = runs.ticket_id)", workspace: "runs.workspace_id" },
    "$2",
  );
  const { rows } = await db.query<Row>(
    `select ${columns} from runs join agents on agents.id = runs.agent_id
     where runs.id = $1 and ${view.sql} ${lock ? "for update of runs" : ""}`,
    [runId, view.value],
  );
  return rows[0];
}

export async function findRun(db: Db, viewer: Viewer, runId: string): Promise<Run> {
  const row = await findRunRow(db, viewer, runId);
  if (!row) throw runNotFound();
  return present(row);
}

/** The full Brief the Run started from. */
export async function briefOfRun(db: Db, viewer: Viewer, runId: string): Promise<Brief> {
  const row = await findRunRow(db, viewer, runId);
  if (!row) throw runNotFound();
  return row.brief;
}

/** What `startRunIfNeeded` did: recorded a Run (running or refused), left the Ticket waiting, or neither. */
export type RunNeed = "started" | "waiting" | "none";

/**
 * Starts a Run on the Ticket if it needs one: it is delegated, sits in a Status with a Step and
 * has no running Run. Call it, in the transaction that locked the Ticket, after the Ticket entered
 * its Status or its Delegate changed. The Run is recorded as running at once, and the Runner is asked to
 * start it once the transaction commits. A Delegate using no Runner gets a Run refused at once.
 *
 * A Ticket that needs a Run but is blocked, or whose Runner has no slot for it, waits instead: a slot
 * goes to the highest Priority waiting Ticket first, then to the one that entered its Status first.
 *
 * A delegated Ticket that doesn't pass the Step's Label rule, or a Merge Step's rule (Autonomous Delegation in a
 * Project with agents may merge on and Pull Request automation on, unless a User queued it in the Merge Queue), gets
 * no Run: Cronk moves it on by the Step's default Outcome, which counts as
 * entering that Status in turn. A chain of skips that comes back to a Status it already passed stops there, so the
 * Ticket waits for a User. A Ticket that passes a Merge Step's rule joins the Merge Queue instead of getting a Run,
 * when it has an open Pull Request to queue; a queued Ticket gets no Merge Run, Cronk merging it (ADR 0011).
 */
export async function startRunIfNeeded(context: Context, tx: Tx, ticketId: string, now: Date): Promise<RunNeed> {
  return enterStatus(context, tx, ticketId, now, new Set());
}

/** Starts a Run on the Ticket as `startRunIfNeeded` says; `skipped` holds the Statuses this chain of skips passed. */
async function enterStatus(context: Context, tx: Tx, ticketId: string, now: Date, skipped: Set<string>): Promise<RunNeed> {
  const { rows } = await tx.query<{
    workspaceId: string;
    projectId: string;
    projectKey: string;
    projectName: string;
    key: string;
    statusId: string;
    labels: string[];
    delegateId: string | null;
    delegateRemoved: boolean;
    autonomousDelegation: boolean | null;
    agentsMayMerge: boolean;
    conciseReports: boolean;
    agentName: string | null;
    runnerId: string | null;
    runnerOwnerId: string | null;
    runnerName: string | null;
    runnerKind: string | null;
    waits: boolean;
    blocked: boolean;
    archived: boolean;
  }>(
    `select tickets.workspace_id as "workspaceId", tickets.project_id as "projectId", projects.key as "projectKey",
       projects.name as "projectName", projects.key || '-' || tickets.number as key, tickets.status_id as "statusId",
       tickets.labels, tickets.delegate_id as "delegateId", agents.removed_at is not null as "delegateRemoved",
       tickets.autonomous_delegation as "autonomousDelegation", projects.agents_may_merge as "agentsMayMerge",
       projects.concise_reports as "conciseReports", agents.name as "agentName", runners.id as "runnerId",
       runners.owner_id as "runnerOwnerId", runners.name as "runnerName", runners.kind as "runnerKind",
       tickets.waits_for_run as waits, ${isBlocked("tickets")} as blocked,
       projects.archived_at is not null as archived
     from tickets join projects on projects.id = tickets.project_id
     left join agents on agents.id = tickets.delegate_id
     left join runners on runners.id = agents.runner_id
     where tickets.id = $1`,
    [ticketId],
  );
  const ticket = rows[0];
  if (!ticket) return "none";
  /** Marks whether the Ticket waits for a Run, telling the Workspace's streams if that changed its card. */
  const waitForRun = async (waits: boolean) => {
    if (ticket.waits === waits) return;
    const [locked] = await lockTickets(tx, [ticketId]);
    await writeTicket(context, tx, locked!, { kind: "cronk" }, { waitsForRun: waits }, { at: now });
  };
  const needsNone = async () => {
    await waitForRun(false);
    return "none" as const;
  };
  // A removed Agent's Runs could never call back: its tokens are refused. Removing it undelegates its Tickets,
  // so this guards only Tickets left delegated to it some other way.
  if (!ticket.delegateId || ticket.delegateRemoved) return needsNone();
  const statuses = await statusesOf(tx, ticket.projectId);
  const status = statuses.find((s) => s.id === ticket.statusId)!;
  // Finished or canceled work gets no Runs, even from a Step saved there before that was refused.
  if (!status.step || !mayHaveStep(status.kind)) return needsNone();
  // An archived Project spends nothing: its Tickets wait where they are, skipping no Step, until it is unarchived.
  if (ticket.archived) {
    const { rowCount: running } = await tx.query("select 1 from runs where ticket_id = $1 and state = 'running'", [ticketId]);
    if (running) return needsNone();
    await waitForRun(true);
    return "waiting";
  }
  // A Ticket queued in the Merge Queue waits there for Cronk to merge it, with no Merge Run (ADR 0011), unless one of its
  // entries stepped aside for a conflict: then it gets a Run to resolve it, whatever the Step's rules say.
  let resolving = false;
  if (status.step.kind === "merge") {
    const { rowCount: queued } = await tx.query("select from merge_queue where ticket_id = $1 and status_id = $2", [ticketId, status.id]);
    if (queued && !(await resolvingConflict(tx, ticketId))) return needsNone();
    resolving = queued !== 0;
  }
  // A Merge Step skips itself unless an agent may merge this Ticket, or a User queued it; otherwise the Label rule decides.
  const mergeRule =
    status.step.kind === "merge" && !resolving
      ? mergeRefusal(ticket.agentsMayMerge, ticket.autonomousDelegation === true, await pullRequestAutomation(tx, ticket.projectId))
      : null;
  // An agent may merge it: it joins the Merge Queue for its Agent, with no Merge Run, if it has a Pull Request to queue.
  // One with none gets a Run, to find out why.
  if (status.step.kind === "merge" && !resolving && !mergeRule && passes(status.step.labelRule, ticket.labels)) {
    if (await joinQueueAutonomously(context, tx, { id: ticketId, ...ticket }, status.id, ticket.delegateId, now)) return needsNone();
  }
  if (!resolving && (mergeRule || !passes(status.step.labelRule, ticket.labels))) {
    const outcome = status.step.outcomes.find((o) => o.default)!;
    if (skipped.has(status.id) || outcome.statusId === status.id) return needsNone();
    skipped.add(status.id);
    const target = statuses.find((s) => s.id === outcome.statusId)!;
    const named = ({ id, name }: Status) => ({ id, name });
    const [locked] = await lockTickets(tx, [ticketId]);
    await writeTicket(context, tx, locked!, { kind: "cronk" }, { statusId: target.id }, {
      at: now,
      changes: [
        {
          field: "stepSkipped",
          from: null,
          to: mergeRule
            ? { status: named(status), labelRule: null, mergeRule, outcome: outcome.name }
            : { status: named(status), labelRule: status.step.labelRule, outcome: outcome.name },
        },
      ],
    });
    // A failure known before the default Outcome moved it into a Review Status sends it back, and Runs start from there;
    // otherwise Cronk asks GitHub whether its Pull Requests conflict.
    if (target.kind === "review") await sendBackOnEnteringReview(context, tx, ticketId);
    return enterStatus(context, tx, ticketId, now, skipped);
  }
  // A running Run holds its Ticket: no other is recorded beside it, not even a refused one.
  const { rowCount: running } = await tx.query("select 1 from runs where ticket_id = $1 and state = 'running'", [ticketId]);
  if (running) return needsNone();
  // Removing a Runner holds this lock while it clears its Agents: if one was removed since the read above, read again.
  if (ticket.runnerId && !(await lockRunnerIfAny(tx, ticket.runnerId))) return enterStatus(context, tx, ticketId, now, skipped);
  const runner = ticket.runnerKind ? context.runners[ticket.runnerKind] : undefined;
  const refusal = !ticket.runnerId
    ? `${ticket.agentName} uses no Runner: its Owner points it at one of their Runners for it to start Runs.`
    : !runner
      ? `This Cronk can't start Runs through ${ticket.runnerName}, a Runner of the kind ${ticket.runnerKind}.`
      : runner.cloud && isLocalOnly(ticket.labels)
        ? localOnlyRefusal(ticket.key, ticket.agentName!, ticket.runnerName!)
        : null;
  // A Run that will be refused takes no slot, so it doesn't wait for one.
  if (ticket.blocked || (runner && !refusal && !(await hasSlotFor(tx, ticket.runnerId!, ticketId)))) {
    await waitForRun(true);
    return "waiting";
  }
  await waitForRun(false);

  const runId = randomUUID();
  const brief = buildBrief(
    context.config,
    ticket.key,
    statuses,
    status as Status & { step: Step },
    { autonomous: ticket.autonomousDelegation === true, conciseReports: ticket.conciseReports, runId },
  );
  // At most one running Run per Ticket: a second is never recorded, even by requests racing this one.
  const inserted = await tx.query(
    `insert into runs (id, workspace_id, ticket_id, status_id, status_name, model, agent_id, runner_id, state, brief,
       end_reason, started_at, ended_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     on conflict (ticket_id) where state = 'running' do nothing`,
    [
      runId,
      ticket.workspaceId,
      ticketId,
      status.id,
      status.name,
      status.step.model,
      ticket.delegateId,
      ticket.runnerId,
      refusal ? "refused" : "running",
      brief,
      refusal,
      now,
      refusal ? now : null,
    ],
  );
  if (inserted.rowCount === 0) return "none";
  if (!runner || refusal) return "started";
  runnerChanged(context, tx, { runnerId: ticket.runnerId!, ownerId: ticket.runnerOwnerId! });

  const { rows: repositories } = await tx.query<{ id: string; fullName: string }>(
    `select repositories.id, repositories.full_name as "fullName"
     from project_repositories join repositories on repositories.id = project_repositories.repository_id
     where project_repositories.project_id = $1
     order by lower(repositories.full_name), repositories.id`,
    [ticket.projectId],
  );
  const start: RunToStart = {
    runId,
    brief: brief.text,
    model: status.step.model,
    ticket: { id: ticketId, key: ticket.key },
    project: { id: ticket.projectId, key: ticket.projectKey, name: ticket.projectName },
    // `bigint` comes back as a string; GitHub's ids fit in a JavaScript number.
    repositories: repositories.map((r) => ({ id: Number(r.id), fullName: r.fullName })),
    agent: { id: ticket.delegateId, name: ticket.agentName! },
    runner: { id: ticket.runnerId!, ownerId: ticket.runnerOwnerId!, name: ticket.runnerName! },
  };
  afterCommit(tx, async () => {
    let result: StartResult;
    try {
      result = await runner.start(start);
    } catch (error) {
      result = { started: false, refusal: { kind: "unavailable", message: (error as Error).message } };
    }
    await transaction(context.db, async (tx) => {
      if (result.started) {
        await tx.query("update runs set session_id = $2, session_url = $3 where id = $1", [
          runId,
          result.reference.sessionId ? sessionIdOf(result.reference.sessionId) : null,
          result.reference.url ?? null,
        ]);
      } else if (result.refusal.kind === "rate_limited") {
        // A rate limit is no fault to fix: the Run is unrecorded and the Ticket waits, rather than showing as
        // couldn't-start. The Runner's queue pauses until the limit passes, so none of its waiting Tickets meet
        // the same limit meanwhile; the periodic check resumes it then (`resumePausedRunners`).
        const slot = await lockSlotOf(tx, runId);
        const { rowCount } = await tx.query("delete from runs where id = $1 and state = 'running'", [runId]);
        if (rowCount) {
          const [locked] = await lockTickets(tx, [ticketId]);
          if (locked) await writeTicket(context, tx, locked, { kind: "cronk" }, { waitsForRun: true }, { at: context.clock.now() });
        }
        if (slot) {
          await tx.query("update runners set paused_until = greatest(paused_until, $2) where id = $1", [
            slot.runnerId,
            result.refusal.retryAt,
          ]);
          runnerChanged(context, tx, slot);
        }
      } else {
        await freeSlot(context, tx, runId);
        await tx.query(
          "update runs set state = 'refused', end_reason = $2, ended_at = $3 where id = $1 and state = 'running'",
          [runId, result.refusal.message, context.clock.now()],
        );
      }
      context.live.publish(tx, ticket.workspaceId, { type: "ticket.changed", projectId: ticket.projectId, ticketId });
    });
  });
  return "started";
}

/** Why a `local-only` Ticket gets no Run through its Delegate's cloud Runner. */
function localOnlyRefusal(key: string, agentName: string, runnerName: string): string {
  return (
    `${key} is labelled local-only: it can't run in a cloud session, and ${agentName} uses ${runnerName}, a cloud Runner. ` +
    "Delegate it to an Agent whose Runner isn't in the cloud, or remove the label."
  );
}

/**
 * Holds the Runner's slots still until the transaction ends: everything that starts or ends a Run through
 * it takes this lock, so counting its running Runs and waiting Tickets gives the answer that stands.
 */
async function lockRunner(tx: Tx, runnerId: string): Promise<{ limit: number; paused: boolean; ownerId: string }> {
  const runner = await lockRunnerIfAny(tx, runnerId);
  if (!runner) throw new Error(`Runner ${runnerId} is gone`);
  return runner;
}

/** As `lockRunner`, but nothing if the Runner was removed meanwhile. */
async function lockRunnerIfAny(tx: Tx, runnerId: string): Promise<{ limit: number; paused: boolean; ownerId: string } | undefined> {
  const { rows } = await tx.query<{ limit: number; paused: boolean; ownerId: string }>(
    `select run_limit as limit, paused_until is not null as paused, owner_id as "ownerId" from runners where id = $1 for update`,
    [runnerId],
  );
  return rows[0];
}

/**
 * Call before ending the Run: locks it, then holds its Runner's slots still (always in that order), and once the transaction commits gives the slot
 * the Run frees to the Runner's next waiting Ticket. The Runner's Owner is told its count of running Runs changed.
 */
async function freeSlot(context: Context, tx: Tx, runId: string): Promise<void> {
  const slot = await lockSlotOf(tx, runId);
  if (!slot) return;
  runnerChanged(context, tx, slot);
  afterCommit(tx, () => startWaitingRuns(context, slot.runnerId));
}

/** Locks the Run, then holds its Runner's slots still; returns the Runner and its Owner, if it has one. */
async function lockSlotOf(tx: Tx, runId: string): Promise<{ runnerId: string; ownerId: string } | null> {
  const { rows } = await tx.query<{ runnerId: string | null }>(`select runner_id as "runnerId" from runs where id = $1 for update`, [
    runId,
  ]);
  const runnerId = rows[0]?.runnerId ?? null;
  if (!runnerId) return null;
  const { ownerId } = await lockRunner(tx, runnerId);
  return { runnerId, ownerId };
}

/** Tells the Runner's Owner, once the transaction commits, that it changed: a Run started or ended on it, or its queue paused or resumed. */
function runnerChanged(context: Context, tx: Tx, { runnerId, ownerId }: { runnerId: string; ownerId: string }): void {
  context.live.publishToOwner(tx, ownerId, { type: "runner.changed", runnerId });
}

/**
 * Whether the Runner has a slot for the Ticket now, after the waiting Tickets ahead of it in the queue:
 * none while its queue is paused by a rate limit.
 */
async function hasSlotFor(tx: Tx, runnerId: string, ticketId: string): Promise<boolean> {
  const { limit, paused } = await lockRunner(tx, runnerId);
  if (paused) return false;
  const { rows } = await tx.query<{ taken: number }>(
    `select (select count(*) from runs where runner_id = $1 and state = 'running')
       + (select count(*) from tickets waiting join agents on agents.id = waiting.delegate_id
          where agents.runner_id = $1 and waiting.waits_for_run and waiting.id <> $2 and not ${isBlocked("waiting")}
            and not ${inArchivedProject("waiting")}
            and (${queueOrder("waiting")}) < (select ${queueOrder("tickets")} from tickets where id = $2)) as taken`,
    [runnerId, ticketId],
  );
  return Number(rows[0]!.taken) < limit;
}

/**
 * Call after something changed what blocks Tickets: the `moved` Tickets entered a Status, or their Status
 * changed kind, so what they block and their parents may now have only finished blockers and Sub-Tickets, or
 * an unfinished one again; or they were renamed; or the Tickets named in `also` lost a blocker or a Sub-Ticket.
 * Their cards change, every Ticket the `moved` ones block among them, since each card lists its unfinished
 * blockers; once the transaction commits, those waiting for a Run are rechecked.
 */
export async function blockingChanged(context: Context, tx: Tx, moved: string[], also: string[] = []): Promise<void> {
  const { rows } = await tx.query<WaitingTicket & { workspaceId: string; projectId: string; waits: boolean }>(
    `select tickets.id, tickets.workspace_id as "workspaceId", tickets.project_id as "projectId",
       agents.runner_id as "runnerId", tickets.waits_for_run as waits
     from tickets left join agents on agents.id = tickets.delegate_id
     where tickets.id in (select other_ticket_id from relations where kind = 'blocks' and ticket_id = any($1::uuid[]))
       or (tickets.waits_for_run and (tickets.id = any($2::uuid[])
         or tickets.id in (select parent_id from tickets where id = any($1::uuid[]))))`,
    [moved, also],
  );
  for (const { id, workspaceId, projectId } of rows) {
    context.live.publish(tx, workspaceId, { type: "ticket.changed", projectId, ticketId: id });
  }
  recheckWaiting(context, tx, rows.filter((row) => row.waits));
}

/** A waiting Ticket, with the Runner its Delegate uses, if any. */
export interface WaitingTicket {
  id: string;
  runnerId: string | null;
}

/** The Tickets waiting for a Run that match the SQL condition on `tickets`, with their Runners. */
export async function waitingTickets(tx: Tx, where: string, params: unknown[]): Promise<WaitingTicket[]> {
  const { rows } = await tx.query<WaitingTicket>(
    `select tickets.id, agents.runner_id as "runnerId"
     from tickets left join agents on agents.id = tickets.delegate_id
     where tickets.waits_for_run and ${where}
     order by ${queueOrder("tickets")}`,
    params,
  );
  return rows;
}

/**
 * Once the transaction commits, rechecks each of the Tickets, which starts it, keeps it waiting or ends its wait, and
 * then gives their Runners' free slots out in queue order. They are waiting Tickets, or Tickets whose Run couldn't start
 * for want of a trigger's token that was just pasted.
 */
export function recheckWaiting(context: Context, tx: Tx, tickets: WaitingTicket[]): void {
  if (tickets.length === 0) return;
  afterCommit(tx, async () => {
    for (const { id } of tickets) await recheck(context, id);
    for (const runnerId of new Set(tickets.flatMap((t) => t.runnerId ?? []))) await startWaitingRuns(context, runnerId);
  });
}

/** Rechecks whether the Ticket needs a Run, in a transaction of its own. */
async function recheck(context: Context, ticketId: string): Promise<RunNeed> {
  return transaction(context.db, async (tx) => {
    await tx.query("select 1 from tickets where id = $1 for update", [ticketId]);
    return startRunIfNeeded(context, tx, ticketId, context.clock.now());
  });
}

/**
 * Gives the Runner's free slots to its waiting Tickets, highest Priority first, then the one that entered its
 * Status first, until it is full. Call it once a transaction that freed a slot or unblocked a Ticket commits.
 * Each Ticket is started in a transaction of its own, so no two Tickets are held at once.
 */
export async function startWaitingRuns(context: Context, runnerId: string): Promise<void> {
  for (;;) {
    const { rows } = await context.db.query<{ id: string }>(
      `select tickets.id from tickets join agents on agents.id = tickets.delegate_id
       where agents.runner_id = $1 and tickets.waits_for_run and not ${isBlocked("tickets")}
         and not ${inArchivedProject("tickets")}
       order by ${queueOrder("tickets")} limit 1`,
      [runnerId],
    );
    const next = rows[0];
    if (!next) return;
    if ((await recheck(context, next.id)) === "waiting") return;
  }
}

/** Resumes the queues of rate-limited Runners whose pause has passed, giving out their free slots. */
export async function resumePausedRunners(context: Context): Promise<void> {
  const resumed = await transaction(context.db, async (tx) => {
    const { rows } = await tx.query<{ runnerId: string; ownerId: string }>(
      `update runners set paused_until = null where paused_until <= $1 returning id as "runnerId", owner_id as "ownerId"`,
      [context.clock.now()],
    );
    for (const runner of rows) runnerChanged(context, tx, runner);
    return rows;
  });
  for (const { runnerId } of resumed) await startWaitingRuns(context, runnerId);
}

/**
 * Stops the Ticket's running Run, if it has one, because a User took the Ticket away from it: moved,
 * undelegated or re-delegated it. Call it in the transaction that locked the Ticket. Its slot goes to the
 * Runner's next waiting Ticket; once the transaction commits, Cronk asks the Run's Runner to stop it too,
 * where the Runner can. Either way the Run's later calls are refused.
 */
export async function stopRunningRun(context: Context, tx: Tx, ticketId: string, reason: string, now: Date): Promise<void> {
  const { rows: running } = await tx.query<{ id: string }>(
    "select id from runs where ticket_id = $1 and state = 'running'",
    [ticketId],
  );
  for (const { id } of running) {
    await freeSlot(context, tx, id);
    const { rows } = await tx.query<EndedRun>(
      `update runs set state = 'stopped', end_reason = $2, ended_at = $3 where id = $1 returning ${endedRunColumns}`,
      [id, reason, now],
    );
    for (const run of rows) tellRunner(context, tx, run, "stop");
  }
}

/**
 * What a `runStopped` Change records: the Run Cronk stopped, its Step's name, its Agent, and why: `projectArchived`
 * when an Admin archived the Ticket's Project.
 */
export interface RunStopped {
  runId: string;
  step: string;
  agent: { id: string; name: string };
  why: "projectArchived";
}

/**
 * Call in the transaction that archived the Project, holding its lock: stops each of its running Runs, as an
 * undelegation stops one, recording Cronk's `runStopped` Change on its Ticket. Each Ticket then waits for a Run,
 * as every delegated Ticket of an archived Project does, so unarchiving starts it again.
 */
export async function stopRunsOfArchivedProject(
  context: Context,
  tx: Tx,
  project: { id: string; key: string },
  archivedBy: string,
  now: Date,
): Promise<void> {
  const { rows } = await tx.query<{ ticketId: string; runId: string; step: string; agentId: string; agentName: string }>(
    `select tickets.id as "ticketId", runs.id as "runId", runs.status_name as step, agents.id as "agentId",
       agents.name as "agentName"
     from tickets join runs on runs.ticket_id = tickets.id and runs.state = 'running'
     join agents on agents.id = runs.agent_id
     where tickets.project_id = $1 order by tickets.id for update of tickets`,
    [project.id],
  );
  if (rows.length === 0) return;
  const { rows: named } = await tx.query<{ name: string }>(`select ${userName()} as name from users where id = $1`, [archivedBy]);
  const reason = `${named[0]!.name} archived ${project.key}, stopping its Runs.`;
  for (const run of rows) {
    await stopRunningRun(context, tx, run.ticketId, reason, now);
    const stopped: RunStopped = { runId: run.runId, step: run.step, agent: { id: run.agentId, name: run.agentName }, why: "projectArchived" };
    const [locked] = await lockTickets(tx, [run.ticketId]);
    await writeTicket(context, tx, locked!, { kind: "cronk" }, {}, { at: now, changes: [{ field: "runStopped", from: stopped, to: null }] });
    await startRunIfNeeded(context, tx, run.ticketId, now);
  }
}

/**
 * Call in the transaction that unarchived the Project: once it commits, its Tickets waiting for a Run are
 * rechecked, and start in queue order as their Runners have slots.
 */
export async function resumeRunsOfUnarchivedProject(context: Context, tx: Tx, projectId: string): Promise<void> {
  recheckWaiting(context, tx, await waitingTickets(tx, "tickets.project_id = $1", [projectId]));
}

/** A Run that just ended in Cronk, with what its Runner needs to stop it too. */
interface EndedRun {
  runId: string;
  workspaceId: string;
  ticketId: string;
  sessionId: string | null;
  sessionUrl: string | null;
  runnerKind: string | null;
}

const endedRunColumns = `runs.id as "runId", runs.workspace_id as "workspaceId", runs.ticket_id as "ticketId",
  runs.session_id as "sessionId", runs.session_url as "sessionUrl",
  (select kind from runners where runners.id = runs.runner_id) as "runnerKind"`;

/**
 * Once the transaction commits, tells the Runner of a Run that ended without Cronk stopping it (finished, merged, or
 * reported ended) that it ended, so it lets go of what the Run held. Call it after ending the Run.
 */
async function tellRunnerEnded(context: Context, tx: Tx, runId: string): Promise<void> {
  const { rows } = await tx.query<EndedRun>(`select ${endedRunColumns} from runs where runs.id = $1`, [runId]);
  for (const run of rows) tellRunner(context, tx, run, "ended");
}

/**
 * Once the transaction commits, tells the Run's Runner that Cronk ended the Run itself and asks it to `stop` its
 * session too, or that the Run `ended` otherwise, where the Runner listens.
 */
function tellRunner(context: Context, tx: Tx, run: EndedRun, what: "stop" | "ended"): void {
  const runner = run.runnerKind ? context.runners[run.runnerKind] : undefined;
  const tell = runner?.[what]?.bind(runner);
  if (!tell) return;
  const reference = {
    ...(run.sessionId === null ? {} : { sessionId: run.sessionId }),
    ...(run.sessionUrl === null ? {} : { url: run.sessionUrl }),
  };
  afterCommit(tx, async () => {
    // Best effort: the Run has ended in Cronk whatever its Runner says.
    await tell({ runId: run.runId, reference }).catch(() => {});
  });
}

/**
 * Why a Merge Step skips itself for a Ticket, if it does: its Project has agents may merge off, or the Ticket lacks
 * Autonomous Delegation (ADR 0005).
 */
async function pullRequestAutomation(tx: Tx, projectId: string): Promise<boolean> {
  const { rows } = await tx.query<{ automation: boolean }>("select pull_request_automation as automation from projects where id = $1", [projectId]);
  return rows[0]!.automation;
}

function mergeRefusal(
  agentsMayMerge: boolean,
  autonomous: boolean,
  pullRequestAutomation: boolean,
): "agentsMayMergeOff" | "noAutonomousDelegation" | "pullRequestAutomationOff" | null {
  if (!agentsMayMerge) return "agentsMayMergeOff";
  if (!autonomous) return "noAutonomousDelegation";
  // With Pull Request automation off a merge completes nothing, so there is no Merge Queue to join.
  if (!pullRequestAutomation) return "pullRequestAutomationOff";
  return null;
}

/** Whether a Ticket with these Labels passes the Label rule, matching Labels ignoring case. */
function passes(rule: LabelRule | null, labels: string[]): boolean {
  if (!rule) return true;
  const has = labels.some((label) => label.toLowerCase() === rule.label.toLowerCase());
  return rule.kind === "requires" ? has : !has;
}

/** A running Run, locked with its Ticket, as only its own Agent may act on it. */
export interface OwnRunningRun {
  ticket: TicketRow;
  run: { id: string; agentId: string; statusId: string | null; step: { name: string }; agent: { name: string } };
}

/**
 * Locks the Ticket, then the Run (as everything that starts Runs locks them), refusing unless the caller is the Run's
 * own Agent and the Run is running. `rule` names the rule a refusal breaks, `action` what only its Agent does, as in
 * "Only claude-max, the Run's Agent, finishes it.", and `notRunning` what can't be done to a Run that isn't running.
 */
export async function lockOwnRunningRun(
  tx: Tx,
  caller: Caller,
  runId: string,
  { rule, action, notRunning }: { rule: string; action: string; notRunning: string },
): Promise<OwnRunningRun> {
  const found = await findRunRow(tx, caller, runId);
  if (!found) throw runNotFound();
  const ticket = (await findTicketRow(tx, caller, found.ticketId, { lock: true }))!;
  const run = (await findRunRow(tx, caller, runId, { lock: true }))!;
  if (caller.kind !== "agent") {
    throw new ApiError(403, "not_runs_agent", `Only ${run.agent.name}, the Run's Agent, ${action}.`, {
      rule,
      advice: "Leave the Run to its Agent; a User moves its Ticket instead.",
    });
  }
  if (run.agentId !== caller.id) {
    throw new ApiError(403, "not_your_run", `This Run is ${run.agent.name}'s, not yours.`, {
      rule,
      advice: "Use the Run whose id your own Brief gives you.",
    });
  }
  if (run.state !== "running") {
    throw new ApiError(409, "run_not_running", `This Run is ${run.state}, not running, so it ${notRunning}.`, {
      rule,
      advice: "Nothing more is needed for this Run; leave a Comment on its Ticket if you have more to say.",
    });
  }
  return { ticket, run };
}

/**
 * Ends the Ticket's running Run as finished with an Outcome that moved nothing itself, such as *merged*: its slot
 * goes to its Runner's next waiting Ticket. Call it in the transaction that locked the Run with `lockOwnRunningRun`.
 */
export async function endRunFinished(context: Context, tx: Tx, runId: string, outcome: string, now: Date): Promise<void> {
  await freeSlot(context, tx, runId);
  await tx.query("update runs set state = 'finished', outcome = $2, ended_at = $3 where id = $1", [runId, outcome, now]);
  await tellRunnerEnded(context, tx, runId);
}

/** A Run as the API shows it, read in the caller's view. */
export async function presentRun(tx: Tx, viewer: Viewer, runId: string): Promise<Run> {
  return present((await findRunRow(tx, viewer, runId))!);
}

/**
 * Ends a running Run as its Agent chose, applying the Outcome: the Run is finished and its Ticket
 * moves to the Outcome's Status, which starts the next Run if that Status has a Step.
 */
export async function finishRun(
  context: Context,
  caller: Caller,
  runId: string,
  input: { outcome: string; question?: string; report?: string },
): Promise<Run> {
  const { db } = context;
  return transaction(db, async (tx) => {
    const finishRule = "A Run is finished only by its own Agent, once, while it is running, with an Outcome its Brief offers.";
    const { ticket, run } = await lockOwnRunningRun(tx, caller, runId, {
      rule: finishRule,
      action: "finishes it",
      notRunning: "can't be finished",
    });
    const statuses = await statusesOf(tx, ticket.projectId);
    const step = statuses.find((s) => s.id === run.statusId)?.step;
    const offered = step ? offeredOutcomes(step, statuses, ticket.autonomousDelegation === true) : [];
    const chosen = offered.find((o) => o.name.toLowerCase() === input.outcome.trim().toLowerCase());
    // A Run of a Merge Step resolving a conflict: sending the Ticket back counts as no round, the conflict cap
    // counting instead; its resolving Outcome is for that Run only.
    const stepStatus = statuses.find((s) => s.id === run.statusId);
    const resolving = step?.kind === "merge" && (await resolvingConflict(tx, ticket.id));
    const resolves = chosen !== undefined && stepStatus !== undefined && resolvingOutcome(stepStatus)?.name === chosen.name;
    if (resolves && !resolving) {
      throw new ApiError(409, "nothing_to_resolve", `${ticket.key} has no conflict in the Merge Queue to resolve, so it can't finish ${chosen.name}.`, {
        rule: `${chosen.name} is for a Run resolving a conflict that set its Ticket aside in the Merge Queue.`,
        advice: `Finish with another Outcome: ${offered.filter((o) => o !== chosen).map((o) => o.name).join(", ")}.`,
      });
    }
    const outcome = chosen && resolving && chosen.countsAsRound ? { ...chosen, countsAsRound: false } : chosen;
    if (!outcome) {
      throw new ApiError(400, "outcome_not_offered", `${input.outcome} isn't an Outcome this Run may choose.`, {
        rule: finishRule,
        advice:
          offered.length > 0
            ? `Finish with one of these Outcomes: ${offered.map((o) => o.name).join(", ")}.`
            : `The Step this Run was of is gone, so it offers no Outcome: leave a Comment for the Ticket's Assignee instead.`,
      });
    }

    if (outcome.needsYou && !input.question?.trim()) {
      throw new ApiError(400, "question_needed", `${outcome.name} hands ${ticket.key} back to its Assignee, so it takes a Question.`, {
        rule: "A Run that finishes with its Step's needs you Outcome says what it needs in a Question.",
        advice: `Finish with ${outcome.name} again, giving a Question that says what you need from the Assignee.`,
      });
    }

    const asking = { id: run.id, agentId: run.agentId, statusId: run.statusId, stepName: run.step.name };
    await moveByCronk(context, tx, ticket, {
      target: { kind: "outcome", step: { statusId: run.statusId!, name: run.step.name }, outcome },
      by: { kind: "agent", id: run.agentId, runId: run.id },
      runId: run.id,
      // A Run completing its Ticket leaves it Unverified, until a User Accepts or Reopens it.
      verification: "unverified",
      beforeMove: async ({ outcome: applied, question: cronksQuestion }, now) => {
        const question = cronksQuestion ?? input.question ?? null;
        const questionBy: QuestionBy | null = cronksQuestion !== null ? "cronk" : question === null ? null : "agent";
        await freeSlot(context, tx, run.id);
        await tx.query(
          `update runs set state = 'finished', outcome = $2, question = $3, question_by = $4, ended_at = $5 where id = $1`,
          [run.id, applied!.name, question, questionBy, now],
        );
        await tellRunnerEnded(context, tx, run.id);
        // Resolved: the entry waits, out of line, for the resolution's checks, so the Ticket gets no other Run here.
        if (resolves) await conflictResolved(context, tx, ticket);
        if (input.report !== undefined) {
          await recordReport(context, tx, ticket, run, { title: `${run.step.name} report`, body: input.report });
        }
        // The Agent's own Question shows on the Ticket as its Comment; Cronk's, at the round limit, shows on the Run
        // and with the Ticket's needs you in the Inbox.
        if (applied!.needsYou && questionBy === "agent") await askQuestion(context, tx, ticket, asking, question!, now);
      },
    });
    return present((await findRunRow(tx, caller, run.id))!);
  });
}

/**
 * Starts a fresh Run of the same Step on a Ticket whose latest Run failed, was lost or couldn't
 * start, while the Ticket is still delegated and in that Run's Status. Only the Delegate's Owner
 * retries, since the Run spends their credentials. Like any Ticket needing a Run, it waits while its
 * Runner is full or it is blocked. Returns the Ticket, with its new latest Run or what it waits for.
 */
export async function retryRun(context: Context, userId: string, ticketId: string): Promise<Ticket> {
  return transaction(context.db, async (tx) => {
    const ticket = await findTicketRow(tx, userViewer(userId), ticketId, { lock: true });
    if (!ticket) throw ticketNotFound();
    await requireWrite(tx, userViewer(userId), ticket);
    const { rows } = await tx.query<{ state: RunState; statusId: string | null }>(
      `select state, status_id as "statusId" from runs where ticket_id = $1 order by seq desc limit 1`,
      [ticket.id],
    );
    const latest = rows[0];
    const why = !latest
      ? `${ticket.key} has had no Run`
      : !wentWrong(latest.state)
        ? `${ticket.key}'s latest Run is ${latest.state}`
        : latest.statusId !== ticket.statusId
          ? `${ticket.key} has moved on from the Status its latest Run was in`
          : !ticket.delegateId
            ? `${ticket.key} isn't delegated`
            : null;
    if (why) {
      throw new ApiError(409, "nothing_to_retry", `${why}, so there is nothing to retry.`, {
        rule: "Retry starts a fresh Run on a delegated Ticket whose latest Run failed, was lost or couldn't start, while it is still in that Run's Status.",
        advice: "Move the Ticket into a Status with a Step, or delegate it, to start a Run there.",
      });
    }
    const { rows: owners } = await tx.query<{ ownerId: string; agentName: string; ownerName: string }>(
      `select agents.owner_id as "ownerId", agents.name as "agentName", ${userName()} as "ownerName"
       from agents join users on users.id = agents.owner_id where agents.id = $1`,
      [ticket.delegateId],
    );
    const owner = owners[0]!;
    if (owner.ownerId !== userId) {
      throw new ApiError(
        403,
        "not_delegates_owner",
        `Only ${owner.ownerName}, the Owner of ${owner.agentName}, retries ${ticket.key}: its Runs spend their credentials.`,
      );
    }
    await startRunIfNeeded(context, tx, ticket.id, context.clock.now());
    context.live.publish(tx, ticket.workspaceId, { type: "ticket.changed", projectId: ticket.projectId, ticketId: ticket.id });
    return (await findTicket(tx, userViewer(userId), ticket.id))!;
  });
}

/**
 * Makes lost every running Run whose Agent made no call naming it or its Ticket for its Workspace's
 * lost-Run threshold, each in a transaction of its own. The server runs this periodically; tests run it
 * directly after moving the clock. A lost Run's Ticket stays where it is, waiting for Retry; its slot goes
 * to the Runner's next waiting Ticket, and its Runner is asked to stop it, where it can.
 */
export async function checkForLostRuns(context: Context): Promise<void> {
  const silent = `runs.state = 'running' and workspaces.id = runs.workspace_id
    and coalesce(runs.last_call_at, runs.started_at) <= $1::timestamptz - make_interval(mins => workspaces.lost_run_minutes)`;
  const now = context.clock.now();
  const { rows: candidates } = await context.db.query<{ id: string }>(
    `select runs.id from runs, workspaces where ${silent}`,
    [now],
  );
  for (const { id } of candidates) {
    await transaction(context.db, async (tx) => {
      await freeSlot(context, tx, id);
      // Checked again under the lock: a call may have named the Run meanwhile.
      const { rows } = await tx.query<EndedRun & { projectId: string }>(
        `update runs set state = 'lost', ended_at = $1,
           end_reason = format('No call named the Run or %s for %s minutes.', projects.key || '-' || tickets.number,
             workspaces.lost_run_minutes)
         from tickets, projects, workspaces
         where runs.id = $2 and tickets.id = runs.ticket_id and projects.id = tickets.project_id and ${silent}
         returning ${endedRunColumns}, tickets.project_id as "projectId"`,
        [now, id],
      );
      for (const run of rows) {
        context.live.publish(tx, run.workspaceId, { type: "ticket.changed", projectId: run.projectId, ticketId: run.ticketId });
        // A lost Run's session may yet be alive: stopping it keeps a Retry from running beside it.
        tellRunner(context, tx, run, "stop");
      }
    });
  }
}

/** What a request names: a Run, a Ticket by id, a Ticket by its key, or the session a Run's Runner returned. */
export interface NamedInCall {
  runId?: string;
  ticketId?: string;
  ticketKey?: string;
  sessionId?: string;
}

/**
 * Records that the Agent called Cronk naming one of its running Runs or that Run's Ticket, whether the
 * call was allowed or not: a Run long without such a call is lost.
 */
export async function noteRunCall({ db, clock }: Context, agent: AgentCaller, named: NamedInCall): Promise<void> {
  const { runId, ticketId, ticketKey, sessionId } = named;
  const ticket = ticketId && isUuid(ticketId)
    ? ticketId
    : ticketKey
      ? (await findTicketRefByKey(db, agent.workspace.id, ticketKey))?.id
      : undefined;
  const run = runId && isUuid(runId) ? runId : undefined;
  if (!ticket && !run && !sessionId) return;
  await db.query(
    `update runs set last_call_at = $3
     where agent_id = $1 and state = 'running' and (id = $2 or ticket_id = $4 or session_id = $5)`,
    [agent.id, run ?? null, clock.now(), ticket ?? null, sessionId ?? null],
  );
}

/**
 * Brings a lost Run back to running when its Agent calls naming it or its Ticket: Cronk only guessed the
 * session was gone, and a call shows it wasn't. Only the Ticket's latest Run comes back, and only while
 * nothing has moved on since: the Ticket is still in the Run's Status, still delegated to its Agent, and
 * has no other running Run. Runs before the call is handled, so a late `finish` is accepted.
 */
export async function reviveLostRun(context: Context, agent: AgentCaller, named: NamedInCall): Promise<void> {
  const { db, clock } = context;
  const { runId, ticketId, ticketKey } = named;
  const ticket = ticketId && isUuid(ticketId)
    ? ticketId
    : ticketKey
      ? (await findTicketRefByKey(db, agent.workspace.id, ticketKey))?.id
      : undefined;
  const run = runId && isUuid(runId) ? runId : undefined;
  if (!ticket && !run) return;
  // Still revivable: the Ticket's latest Run, lost, its Ticket unmoved, still its Agent's, with no Run running.
  const revivable = `runs.agent_id = $1 and runs.state = 'lost' and tickets.id = runs.ticket_id
    and tickets.status_id = runs.status_id and tickets.delegate_id = runs.agent_id
    and runs.id = (select latest.id from runs latest where latest.ticket_id = runs.ticket_id order by latest.started_at desc limit 1)
    and not exists (select 1 from runs other where other.ticket_id = runs.ticket_id and other.state = 'running')`;
  const { rows: candidates } = await db.query<{ id: string; ticketId: string }>(
    `select runs.id, runs.ticket_id as "ticketId" from runs, tickets
     where ${revivable} and (runs.id = $2 or runs.ticket_id = $3)`,
    [agent.id, run ?? null, ticket ?? null],
  );
  const candidate = candidates[0];
  if (!candidate) return;
  await transaction(db, async (tx) => {
    // The Ticket is locked before its Run, and the Run before its Runner's slots, as everywhere else.
    await tx.query("select 1 from tickets where id = $1 for update", [candidate.ticketId]);
    const slot = await lockSlotOf(tx, candidate.id);
    // Checked again under the locks: the Ticket may have moved on meanwhile.
    const { rows } = await tx.query<{ workspaceId: string; projectId: string; ticketId: string }>(
      `update runs set state = 'running', ended_at = null, end_reason = null, last_call_at = $2
       from tickets where runs.id = $3 and ${revivable}
       returning runs.workspace_id as "workspaceId", tickets.project_id as "projectId", runs.ticket_id as "ticketId"`,
      [agent.id, clock.now(), candidate.id],
    );
    const revived = rows[0];
    if (!revived) return;
    if (slot) runnerChanged(context, tx, slot);
    context.live.publish(tx, revived.workspaceId, { type: "ticket.changed", projectId: revived.projectId, ticketId: revived.ticketId });
  });
}

/** Where Runners report their Runs' ends. */
export function runReports(context: Context): RunReports {
  return {
    async endedWithoutFinishing(runId, reason) {
      await transaction(context.db, async (tx) => {
        await freeSlot(context, tx, runId);
        const { rows } = await tx.query<{ workspaceId: string; projectId: string; ticketId: string }>(
          `update runs set state = 'failed', end_reason = $2, ended_at = $3
           from tickets where runs.id = $1 and runs.state = 'running' and tickets.id = runs.ticket_id
           returning runs.workspace_id as "workspaceId", tickets.project_id as "projectId", runs.ticket_id as "ticketId"`,
          [runId, reason, context.clock.now()],
        );
        const run = rows[0];
        if (run) {
          const { workspaceId, projectId, ticketId } = run;
          context.live.publish(tx, workspaceId, { type: "ticket.changed", projectId, ticketId });
          await tellRunnerEnded(context, tx, runId);
        }
      });
    },
    async cost(runId, cost) {
      await transaction(context.db, async (tx) => {
        const { rows } = await tx.query<{
          workspaceId: string;
          projectId: string;
          ticketId: string;
          runnerId: string | null;
          ownerId: string | null;
        }>(
          `update runs set cost_amount = $2, cost_currency = $3
           from tickets where runs.id = $1 and runs.state <> 'running' and tickets.id = runs.ticket_id
             and (runs.cost_amount, runs.cost_currency) is distinct from ($2, $3)
           returning runs.workspace_id as "workspaceId", tickets.project_id as "projectId", runs.ticket_id as "ticketId",
             runs.runner_id as "runnerId", (select owner_id from runners where runners.id = runs.runner_id) as "ownerId"`,
          [runId, cost.amount, cost.currency],
        );
        for (const { workspaceId, projectId, ticketId, runnerId, ownerId } of rows) {
          context.live.publish(tx, workspaceId, { type: "ticket.changed", projectId, ticketId });
          // Its Runner's total for the month changed too.
          if (runnerId && ownerId) runnerChanged(context, tx, { runnerId, ownerId });
        }
      });
    },
  };
}

/**
 * Has the Runner of a running Run add what its session did since it last looked to the Run's Transcript, where its
 * Runner fetches Transcripts itself. Says whether it asked. Opening the Transcript still shows what Cronk holds when
 * the Runner's service can't be reached.
 */
export async function followRunTranscript(context: Context, runId: string, log: FastifyBaseLogger): Promise<boolean> {
  const { rows } = await context.db.query<{ kind: string }>(
    "select runners.kind from runs join runners on runners.id = runs.runner_id where runs.id = $1 and runs.state = 'running'",
    [runId],
  );
  const runner = rows[0] ? context.runners[rows[0].kind] : undefined;
  if (!runner?.followTranscript) return false;
  await runner.followTranscript({ runId }).catch((error: unknown) => log.warn({ err: error, runId }, "Couldn't follow the Run's Transcript"));
  return true;
}
