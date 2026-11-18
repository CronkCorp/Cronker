import { randomUUID } from "node:crypto";
import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { afterCommit, transaction, type Db, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import type { AgentCaller, Caller } from "../identity/callers.js";
import { inView, type Viewer } from "../identity/viewers.js";
import { recordChanges } from "../work/changes.js";
import { statusesOf, type Status } from "../work/projects.js";
import { mayHaveStep, type Step } from "../work/steps.js";
import { recordReport } from "../work/reports.js";
import { findTicketRefByKey, findTicketRow, ticketNotFound } from "../work/tickets.js";
import { Brief, buildBrief, offeredOutcomes } from "./brief.js";
import type { RunReports, RunToStart, StartResult } from "./runner.js";
import { RunState } from "./states.js";
import { isBlocked, queueOrder } from "./waiting.js";

/**
 * Runs: when a Ticket gets one, starting it through its Delegate's Runner, and ending it.
 * A delegated Ticket entering a Status with a Step gets a Run, unless it has a running one;
 * the Run ends when its Agent calls `finish` with an Outcome, or when its Runner reports it
 * ended without finishing.
 */

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
  question: Type.Union([Type.String(), Type.Null()], { description: "The Question its Agent finished it with, if any." }),
  endReason: Type.Union([Type.String(), Type.Null()], {
    description: "Why it failed, or why its Runner refused to start it.",
  }),
  sessionUrl: Type.Union([Type.String(), Type.Null()], { description: "Where to follow the Run, such as its claude.ai session." }),
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
  runs.question, runs.end_reason as "endReason", runs.session_url as "sessionUrl",
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
  const view = inView(viewer, "runs.workspace_id", "$2");
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
 */
export async function startRunIfNeeded(context: Context, tx: Tx, ticketId: string, now: Date): Promise<RunNeed> {
  const { rows } = await tx.query<{
    workspaceId: string;
    projectId: string;
    projectKey: string;
    projectName: string;
    key: string;
    statusId: string;
    delegateId: string | null;
    agentName: string | null;
    runnerId: string | null;
    runnerOwnerId: string | null;
    runnerName: string | null;
    runnerKind: string | null;
    waits: boolean;
    blocked: boolean;
  }>(
    `select tickets.workspace_id as "workspaceId", tickets.project_id as "projectId", projects.key as "projectKey",
       projects.name as "projectName", projects.key || '-' || tickets.number as key, tickets.status_id as "statusId",
       tickets.delegate_id as "delegateId", agents.name as "agentName", runners.id as "runnerId",
       runners.owner_id as "runnerOwnerId", runners.name as "runnerName", runners.kind as "runnerKind",
       tickets.waits_for_run as waits, ${isBlocked("tickets")} as blocked
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
    await tx.query("update tickets set waits_for_run = $2 where id = $1", [ticketId, waits]);
    context.live.publish(tx, ticket.workspaceId, { type: "ticket.changed", projectId: ticket.projectId, ticketId });
  };
  const needsNone = async () => {
    await waitForRun(false);
    return "none" as const;
  };
  if (!ticket.delegateId) return needsNone();
  const statuses = await statusesOf(tx, ticket.projectId);
  const status = statuses.find((s) => s.id === ticket.statusId)!;
  // Finished or canceled work gets no Runs, even from a Step saved there before that was refused.
  if (!status.step || !mayHaveStep(status.kind)) return needsNone();
  // A running Run holds its Ticket: no other is recorded beside it, not even a refused one.
  const { rowCount: running } = await tx.query("select 1 from runs where ticket_id = $1 and state = 'running'", [ticketId]);
  if (running) return needsNone();
  const runner = ticket.runnerKind ? context.runners[ticket.runnerKind] : undefined;
  if (ticket.blocked || (runner && !(await hasSlotFor(tx, ticket.runnerId!, ticketId)))) {
    await waitForRun(true);
    return "waiting";
  }
  await waitForRun(false);

  const runId = randomUUID();
  const brief = buildBrief(context.config, ticket.key, statuses, status as Status & { step: Step }, runId);
  const refusal = !ticket.runnerId
    ? `${ticket.agentName} uses no Runner: its Owner points it at one of their Runners for it to start Runs.`
    : !runner
      ? `This Cronk can't start Runs through ${ticket.runnerName}, a Runner of the kind ${ticket.runnerKind}.`
      : null;
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
  if (!runner) return "started";

  const start: RunToStart = {
    runId,
    brief: brief.text,
    model: status.step.model,
    ticket: { id: ticketId, key: ticket.key },
    project: { id: ticket.projectId, key: ticket.projectKey, name: ticket.projectName },
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
          result.reference.sessionId ?? null,
          result.reference.url ?? null,
        ]);
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

/**
 * Holds the Runner's slots still until the transaction ends: everything that starts or ends a Run through
 * it takes this lock, so counting its running Runs and waiting Tickets gives the answer that stands.
 */
async function lockRunner(tx: Tx, runnerId: string): Promise<{ limit: number }> {
  const { rows } = await tx.query<{ limit: number }>("select run_limit as limit from runners where id = $1 for update", [
    runnerId,
  ]);
  return rows[0]!;
}

/**
 * Call before ending the Run: locks it, then holds its Runner's slots still (always in that order), and once the transaction commits gives the slot
 * the Run frees to the Runner's next waiting Ticket.
 */
async function freeSlot(context: Context, tx: Tx, runId: string): Promise<void> {
  const { rows } = await tx.query<{ runnerId: string | null }>(`select runner_id as "runnerId" from runs where id = $1 for update`, [
    runId,
  ]);
  const runnerId = rows[0]?.runnerId;
  if (!runnerId) return;
  await lockRunner(tx, runnerId);
  afterCommit(tx, () => startWaitingRuns(context, runnerId));
}

/** Whether the Runner has a slot for the Ticket now, after the waiting Tickets ahead of it in the queue. */
async function hasSlotFor(tx: Tx, runnerId: string, ticketId: string): Promise<boolean> {
  const { limit } = await lockRunner(tx, runnerId);
  const { rows } = await tx.query<{ taken: number }>(
    `select (select count(*) from runs where runner_id = $1 and state = 'running')
       + (select count(*) from tickets waiting join agents on agents.id = waiting.delegate_id
          where agents.runner_id = $1 and waiting.waits_for_run and waiting.id <> $2 and not ${isBlocked("waiting")}
            and (${queueOrder("waiting")}) < (select ${queueOrder("tickets")} from tickets where id = $2)) as taken`,
    [runnerId, ticketId],
  );
  return Number(rows[0]!.taken) < limit;
}

/**
 * Call after something may have unblocked waiting Tickets: the `moved` Tickets entered a Status, or their
 * Status changed kind, so what they block and their parents may now have only finished blockers and
 * Sub-Tickets; or the Tickets named in `also` lost a blocker or a Sub-Ticket. Their cards change, and once
 * the transaction commits they are rechecked.
 */
export async function startUnblocked(context: Context, tx: Tx, moved: string[], also: string[] = []): Promise<void> {
  const { rows } = await tx.query<WaitingTicket & { workspaceId: string; projectId: string }>(
    `select tickets.id, tickets.workspace_id as "workspaceId", tickets.project_id as "projectId",
       agents.runner_id as "runnerId"
     from tickets left join agents on agents.id = tickets.delegate_id
     where tickets.waits_for_run and (tickets.id = any($2::uuid[])
       or tickets.id in (select other_ticket_id from relations where kind = 'blocks' and ticket_id = any($1::uuid[]))
       or tickets.id in (select parent_id from tickets where id = any($1::uuid[])))`,
    [moved, also],
  );
  for (const { id, workspaceId, projectId } of rows) {
    context.live.publish(tx, workspaceId, { type: "ticket.changed", projectId, ticketId: id });
  }
  recheckWaiting(context, tx, rows);
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
     where tickets.waits_for_run and ${where}`,
    params,
  );
  return rows;
}

/**
 * Once the transaction commits, rechecks each of the waiting Tickets, which starts it, keeps it waiting or ends
 * its wait, and then gives their Runners' free slots out in queue order.
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
       order by ${queueOrder("tickets")} limit 1`,
      [runnerId],
    );
    const next = rows[0];
    if (!next) return;
    if ((await recheck(context, next.id)) === "waiting") return;
  }
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
  const { db, clock, live } = context;
  return transaction(db, async (tx) => {
    const found = await findRunRow(tx, caller, runId);
    if (!found) throw runNotFound();
    // The Ticket is locked before its Run, as everything else that starts Runs locks them.
    const ticket = (await findTicketRow(tx, caller, found.ticketId, { lock: true }))!;
    const run = (await findRunRow(tx, caller, runId, { lock: true }))!;
    const finishRule = "A Run is finished only by its own Agent, once, while it is running, with an Outcome its Brief offers.";
    if (caller.kind !== "agent") {
      throw new ApiError(403, "not_runs_agent", `Only ${run.agent.name}, the Run's Agent, finishes it.`);
    }
    if (run.agentId !== caller.id) {
      throw new ApiError(403, "not_your_run", `This Run is ${run.agent.name}'s, not yours.`, {
        rule: finishRule,
        advice: "Finish the Run whose id your own Brief gives you.",
      });
    }
    if (run.state !== "running") {
      throw new ApiError(409, "run_not_running", `This Run is ${run.state}, not running, so it can't be finished.`, {
        rule: finishRule,
        advice: "Nothing more is needed for this Run; leave a Comment on its Ticket if you have more to say.",
      });
    }
    if (ticket.statusId !== run.statusId) {
      throw new ApiError(409, "ticket_moved", `${ticket.key} was moved out of ${run.step.name} while this Run was running.`, {
        rule: "A Run's Outcome moves its Ticket only from the Status the Run was started in.",
        advice: `Stop working on ${ticket.key}: a User moved it on. Leave a Comment if there is something they should know.`,
      });
    }
    const statuses = await statusesOf(tx, ticket.projectId);
    const step = statuses.find((s) => s.id === run.statusId)?.step;
    const offered = step ? offeredOutcomes(step, statuses) : [];
    const outcome = offered.find((o) => o.name.toLowerCase() === input.outcome.trim().toLowerCase());
    if (!outcome) {
      throw new ApiError(400, "outcome_not_offered", `${input.outcome} isn't an Outcome this Run may choose.`, {
        rule: finishRule,
        advice:
          offered.length > 0
            ? `Finish with one of these Outcomes: ${offered.map((o) => o.name).join(", ")}.`
            : `The Step this Run was of is gone, so it offers no Outcome: leave a Comment for the Ticket's Assignee instead.`,
      });
    }

    const now = clock.now();
    await freeSlot(context, tx, run.id);
    await tx.query(
      `update runs set state = 'finished', outcome = $2, question = $3, ended_at = $4 where id = $1`,
      [run.id, outcome.name, input.question ?? null, now],
    );
    if (input.report !== undefined) {
      await recordReport(context, tx, ticket, run, { title: `${run.step.name} report`, body: input.report });
    }
    if (outcome.statusId !== ticket.statusId) {
      await tx.query("update tickets set status_id = $2, status_entered_at = $3 where id = $1", [
        ticket.id,
        outcome.statusId,
        now,
      ]);
      const named = (id: string) => ({ id, name: statuses.find((s) => s.id === id)!.name });
      await recordChanges(tx, ticket, { kind: "agent", id: caller.id, runId: run.id }, now, [
        { field: "status", from: named(ticket.statusId), to: named(outcome.statusId) },
      ]);
      await startUnblocked(context, tx, [ticket.id]);
    }
    live.publish(tx, ticket.workspaceId, { type: "ticket.changed", projectId: ticket.projectId, ticketId: ticket.id });
    // Moving into a Status by an Outcome counts as entering it.
    await startRunIfNeeded(context, tx, ticket.id, now);
    return present((await findRunRow(tx, caller, run.id))!);
  });
}

/** What a request names: a Run, a Ticket by id, or a Ticket by its key. */
export interface NamedInCall {
  runId?: string;
  ticketId?: string;
  ticketKey?: string;
}

/**
 * Records that the Agent called Cronk naming one of its running Runs or that Run's Ticket, whether the
 * call was allowed or not: a Run long without such a call is lost.
 */
export async function noteRunCall({ db, clock }: Context, agent: AgentCaller, named: NamedInCall): Promise<void> {
  const { runId, ticketId, ticketKey } = named;
  const ticket = ticketId && isUuid(ticketId)
    ? ticketId
    : ticketKey
      ? (await findTicketRefByKey(db, agent.workspace.id, ticketKey))?.id
      : undefined;
  const run = runId && isUuid(runId) ? runId : undefined;
  if (!ticket && !run) return;
  await db.query(
    `update runs set last_call_at = $3
     where agent_id = $1 and state = 'running' and (id = $2 or ticket_id = $4)`,
    [agent.id, run ?? null, clock.now(), ticket ?? null],
  );
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
        }
      });
    },
  };
}
