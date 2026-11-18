import { randomUUID } from "node:crypto";
import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { afterCommit, transaction, type Db, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import type { Caller } from "../identity/callers.js";
import { inView, type Viewer } from "../identity/viewers.js";
import { recordChanges } from "../work/changes.js";
import { statusesOf, type Status } from "../work/projects.js";
import { mayHaveStep, type LabelRule, type Step } from "../work/steps.js";
import { findTicketRow, ticketNotFound } from "../work/tickets.js";
import { Brief, buildBrief, offeredOutcomes } from "./brief.js";
import type { RunReports, RunToStart, StartResult } from "./runner.js";
import { RunState } from "./states.js";

/**
 * Runs: when a Ticket gets one, starting it through its Delegate's Runner, and ending it.
 * A delegated Ticket entering a Status with a Step gets a Run, unless it has a running one;
 * the Run ends when its Agent calls `finish` with an Outcome, or when its Runner reports it
 * ended without finishing.
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
  report: Type.Union([Type.String(), Type.Null()], { description: "The Report its Agent finished it with, if any, in Markdown." }),
  endReason: Type.Union([Type.String(), Type.Null()], {
    description: "Why it failed, or why its Runner refused to start it.",
  }),
  sessionUrl: Type.Union([Type.String(), Type.Null()], { description: "Where to follow the Run, such as its claude.ai session." }),
  startedAt: Type.String({ format: "date-time" }),
  endedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
});
export type Run = Static<typeof Run>;

type Row = Omit<Run, "startedAt" | "endedAt"> & {
  startedAt: Date;
  endedAt: Date | null;
  workspaceId: string;
  agentId: string;
  statusId: string | null;
  brief: Brief;
};

const columns = `runs.id, runs.ticket_id as "ticketId",
  json_build_object('statusId', runs.status_id, 'name', runs.status_name) as step,
  json_build_object('id', agents.id, 'name', agents.name) as agent, runs.model, runs.state, runs.outcome,
  runs.question, runs.question_by as "questionBy", runs.report, runs.end_reason as "endReason", runs.session_url as "sessionUrl",
  runs.started_at as "startedAt", runs.ended_at as "endedAt",
  runs.workspace_id as "workspaceId", runs.agent_id as "agentId", runs.status_id as "statusId", runs.brief`;

const present = ({ startedAt, endedAt, workspaceId: _w, agentId: _a, statusId: _s, brief: _b, ...row }: Row): Run => ({
  ...row,
  startedAt: startedAt.toISOString(),
  endedAt: endedAt?.toISOString() ?? null,
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

/**
 * Starts a Run on the Ticket if it needs one: it is delegated, sits in a Status with a Step and
 * has no running Run. Call it, in the transaction that locked the Ticket, after the Ticket entered
 * its Status or was delegated. The Run is recorded as running at once, and the Runner is asked to
 * start it once the transaction commits. A Delegate using no Runner gets a Run refused at once.
 *
 * A delegated Ticket that doesn't pass the Step's Label rule gets no Run: Cronk moves it on by the
 * Step's default Outcome, which counts as entering that Status in turn. A chain of skips that comes
 * back to a Status it already passed stops there, so the Ticket waits for a User.
 */
export async function startRunIfNeeded(context: Context, tx: Tx, ticketId: string, now: Date): Promise<void> {
  await enterStatus(context, tx, ticketId, now, new Set());
}

/** Starts a Run on the Ticket as `startRunIfNeeded` says; `skipped` holds the Statuses this chain of skips passed. */
async function enterStatus(context: Context, tx: Tx, ticketId: string, now: Date, skipped: Set<string>): Promise<void> {
  const { rows } = await tx.query<{
    workspaceId: string;
    projectId: string;
    projectKey: string;
    projectName: string;
    key: string;
    statusId: string;
    labels: string[];
    delegateId: string | null;
    agentName: string | null;
    runnerId: string | null;
    runnerOwnerId: string | null;
    runnerName: string | null;
    runnerKind: string | null;
  }>(
    `select tickets.workspace_id as "workspaceId", tickets.project_id as "projectId", projects.key as "projectKey",
       projects.name as "projectName", projects.key || '-' || tickets.number as key, tickets.status_id as "statusId",
       tickets.labels, tickets.delegate_id as "delegateId", agents.name as "agentName", runners.id as "runnerId",
       runners.owner_id as "runnerOwnerId", runners.name as "runnerName", runners.kind as "runnerKind"
     from tickets join projects on projects.id = tickets.project_id
     left join agents on agents.id = tickets.delegate_id
     left join runners on runners.id = agents.runner_id
     where tickets.id = $1`,
    [ticketId],
  );
  const ticket = rows[0];
  if (!ticket?.delegateId) return;
  const statuses = await statusesOf(tx, ticket.projectId);
  const status = statuses.find((s) => s.id === ticket.statusId)!;
  // Finished or canceled work gets no Runs, even from a Step saved there before that was refused.
  if (!status.step || !mayHaveStep(status.kind)) return;
  if (!passes(status.step.labelRule, ticket.labels)) {
    if (skipped.has(status.id)) return;
    skipped.add(status.id);
    const outcome = status.step.outcomes.find((o) => o.default)!;
    if (outcome.statusId === status.id) return;
    const target = statuses.find((s) => s.id === outcome.statusId)!;
    await tx.query("update tickets set status_id = $2 where id = $1", [ticketId, target.id]);
    const named = ({ id, name }: Status) => ({ id, name });
    await recordChanges(tx, { id: ticketId, workspaceId: ticket.workspaceId }, { kind: "cronk" }, now, [
      { field: "stepSkipped", from: null, to: { status: named(status), labelRule: status.step.labelRule, outcome: outcome.name } },
      { field: "status", from: named(status), to: named(target) },
    ]);
    context.live.publish(tx, ticket.workspaceId, { type: "ticket.changed", projectId: ticket.projectId, ticketId });
    return enterStatus(context, tx, ticketId, now, skipped);
  }
  // A running Run holds its Ticket: no other is recorded beside it, not even a refused one.
  const { rowCount: running } = await tx.query("select 1 from runs where ticket_id = $1 and state = 'running'", [ticketId]);
  if (running) return;

  const runId = randomUUID();
  const brief = buildBrief(context.config, ticket.key, statuses, status as Status & { step: Step }, runId);
  const runner = ticket.runnerKind ? context.runners[ticket.runnerKind] : undefined;
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
  if (inserted.rowCount === 0 || !runner) return;

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
        await tx.query(
          "update runs set state = 'refused', end_reason = $2, ended_at = $3 where id = $1 and state = 'running'",
          [runId, result.refusal.message, context.clock.now()],
        );
      }
      context.live.publish(tx, ticket.workspaceId, { type: "ticket.changed", projectId: ticket.projectId, ticketId });
    });
  });
}

const times = (n: number) => (n === 1 ? "once" : `${n} times`);

/** Whether a Ticket with these Labels passes the Label rule, matching Labels ignoring case. */
function passes(rule: LabelRule | null, labels: string[]): boolean {
  if (!rule) return true;
  const has = labels.some((label) => label.toLowerCase() === rule.label.toLowerCase());
  return rule.kind === "requires" ? has : !has;
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

    // An Outcome counting as a round adds one for this Ticket and Step, until the count has reached the
    // Step's round limit: then *needs you* applies instead, with Cronk's own Question.
    let applied = outcome;
    let question = input.question ?? null;
    let questionBy: QuestionBy | null = question === null ? null : "agent";
    if (outcome.countsAsRound && step) {
      const { rows } = await tx.query<{ stepId: string; count: number | null }>(
        `select steps.id as "stepId", round_counts.count from steps
         left join round_counts on round_counts.step_id = steps.id and round_counts.ticket_id = $2
         where steps.status_id = $1`,
        [run.statusId, ticket.id],
      );
      const { stepId, count } = rows[0]!;
      if ((count ?? 0) >= step.roundLimit) {
        applied = step.outcomes.find((o) => o.needsYou)!;
        question =
          `${run.step.name} sent ${ticket.key} back by ${outcome.name} ${times(step.roundLimit)}, its round limit, ` +
          "so it comes to you instead. Read the latest Reports, then move it on yourself.";
        questionBy = "cronk";
      } else {
        await tx.query(
          `insert into round_counts (workspace_id, ticket_id, step_id, count) values ($1, $2, $3, 1)
           on conflict (ticket_id, step_id) do update set count = round_counts.count + 1`,
          [ticket.workspaceId, ticket.id, stepId],
        );
      }
    }

    const now = clock.now();
    await tx.query(
      `update runs set state = 'finished', outcome = $2, question = $3, question_by = $4, report = $5, ended_at = $6
       where id = $1`,
      [run.id, applied.name, question, questionBy, input.report ?? null, now],
    );
    if (applied.statusId !== ticket.statusId) {
      await tx.query("update tickets set status_id = $2 where id = $1", [ticket.id, applied.statusId]);
      const named = (id: string) => ({ id, name: statuses.find((s) => s.id === id)!.name });
      await recordChanges(tx, ticket, { kind: "agent", id: caller.id }, now, [
        { field: "status", from: named(ticket.statusId), to: named(applied.statusId) },
      ]);
    }
    live.publish(tx, ticket.workspaceId, { type: "ticket.changed", projectId: ticket.projectId, ticketId: ticket.id });
    // Moving into a Status by an Outcome counts as entering it.
    await startRunIfNeeded(context, tx, ticket.id, now);
    return present((await findRunRow(tx, caller, run.id))!);
  });
}

/** Where Runners report their Runs' ends. */
export function runReports(context: Context): RunReports {
  return {
    async endedWithoutFinishing(runId, reason) {
      await transaction(context.db, async (tx) => {
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
