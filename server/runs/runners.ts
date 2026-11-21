import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { afterCommit, transaction, type Db, type Tx } from "../db.js";
import { requireSecretBox } from "../encryption.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import { userViewer } from "../identity/viewers.js";
import { findProject } from "../work/projects.js";
import { Cost, costTotalsSql } from "./costs.js";
import { setUpManagedAgents } from "./managed-agents.js";
import { recheckWaiting, startWaitingRuns, stopRunningRun, waitingTickets } from "./runs.js";

/** A subscription Runner's trigger: the claude.ai scheduled task it fires for one model label. Its token is never returned. */
export const Trigger = Type.Object({
  id: Type.String({ format: "uuid" }),
  model: Type.String({ description: "The model label it is for, matched against a Step's model ignoring case." }),
  projectId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
    description: "The Project whose Tickets it fires for, overriding the Runner's own trigger for the model; null for all Projects.",
  }),
  triggerId: Type.String({ description: "The scheduled task's trigger id in claude.ai, such as `trig_01ABC…`." }),
  waitingForToken: Type.Boolean({
    description:
      "Made by a Runner setup and waiting for the token its Owner generates in claude.ai and pastes; Runs needing it " +
      "can't start until then.",
  }),
  routineUrl: Type.String({ format: "uri", description: "The routine's page in claude.ai, where its token is generated." }),
  createdAt: Type.String({ format: "date-time" }),
});
export type Trigger = Static<typeof Trigger>;

/** A Runner's budget per Run as its record shows it. */
const BudgetPerRunField = Type.Union([Cost, Type.Null()], {
  description:
    "For a `managed_agents` Runner, the most each of its Runs may cost at Anthropic's list prices, passed as each " +
    "session's budget; a Run whose session reaches it fails with *budget reached*. Null for none, the default, and " +
    "for other kinds.",
});

/** A Runner a User set up: a way for Cronk to start Runs of their Agents with their own credentials. */
export const RunnerRecord = Type.Object({
  id: Type.String({ format: "uuid" }),
  name: Type.String(),
  kind: Type.String({ description: "Which of this Cronk's kinds of Runner starts its Runs." }),
  limit: Type.Integer({
    minimum: 1,
    description: "How many Runs it keeps running at once; Tickets needing a Run beyond it wait for a slot.",
  }),
  running: Type.Integer({
    minimum: 0,
    description: "How many of its Runs are running now, counted against its limit.",
  }),
  pausedUntil: Type.Union([Type.String({ format: "date-time" }), Type.Null()], {
    description:
      "While its Runs' service rate limits it: until when its queue is paused, so none of its waiting Tickets start. " +
      "Cronk resumes it at the first check (every minute) at or after this time.",
  }),
  triggers: Type.Array(Trigger, {
    description:
      "For a `subscription` Runner, the trigger it fires per model label, the Runner's own first, then each Project's " +
      "overrides; empty for other kinds.",
  }),
  managedAgents: Type.Union(
    [
      Type.Object({
        agentId: Type.String({ description: "The agent definition Cronk created in the Owner's Anthropic workspace." }),
        environmentId: Type.String({ description: "The cloud environment Cronk created there." }),
      }),
      Type.Null(),
    ],
    { description: "For a `managed_agents` Runner, what Cronk created with its API key; null for other kinds." },
  ),
  budgetPerRun: BudgetPerRunField,
  costThisMonth: Type.Array(Cost, {
    description:
      "What its Runs that ended this calendar month (in UTC) cost, one total per currency; empty when none reported a " +
      "cost, as subscription Runs don't.",
  }),
  createdAt: Type.String({ format: "date-time" }),
});
export type RunnerRecord = Static<typeof RunnerRecord>;

type TriggerRow = Omit<Trigger, "createdAt" | "routineUrl"> & { createdAt: string };
type Row = Omit<RunnerRecord, "createdAt" | "pausedUntil" | "triggers"> & {
  createdAt: Date;
  pausedUntil: Date | null;
  triggers: TriggerRow[];
};
const triggerJson = `json_build_object('id', t.id, 'model', t.model, 'projectId', t.project_id, 'triggerId', t.trigger_id,
  'waitingForToken', t.token_sealed is null, 'createdAt', t.created_at)`;
/** The Runners' columns, given the placeholder of the current time, which sets the month `costThisMonth` totals. */
const columns = (now: string) => `id, name, kind, run_limit as limit,
  (select count(*)::int from runs where runs.runner_id = runners.id and runs.state = 'running') as running,
  paused_until as "pausedUntil", created_at as "createdAt",
  case when kind = 'managed_agents' then json_build_object('agentId', managed_agent_id, 'environmentId', managed_environment_id)
  end as "managedAgents",
  case when budget_per_run is not null then json_build_object('amount', budget_per_run, 'currency', 'USD') end
    as "budgetPerRun",
  ${costTotalsSql(`runs.runner_id = runners.id and runs.ended_at >= date_trunc('month', ${now}::timestamptz, 'UTC')`)}
    as "costThisMonth",
  coalesce((select json_agg(${triggerJson} order by t.project_id nulls first, lower(t.model), t.created_at)
    from runner_triggers t where t.runner_id = runners.id), '[]') as triggers`;
const present = (row: Row): RunnerRecord => ({
  ...row,
  pausedUntil: row.pausedUntil?.toISOString() ?? null,
  triggers: row.triggers.map(presentTrigger),
  createdAt: row.createdAt.toISOString(),
});

/** A routine's page in claude.ai, where its Owner generates its token. */
export const routineUrl = (triggerId: string): string => `https://claude.ai/code/routines/${encodeURIComponent(triggerId)}`;

const presentTrigger = (t: TriggerRow): Trigger => ({
  ...t,
  routineUrl: routineUrl(t.triggerId),
  createdAt: new Date(t.createdAt).toISOString(),
});

/** The User's own Runners, oldest first. */
export async function runnersOf({ db, clock }: Context, userId: string): Promise<RunnerRecord[]> {
  const { rows } = await db.query<Row>(`select ${columns("$2")} from runners where owner_id = $1 order by created_at, id`, [
    userId,
    clock.now(),
  ]);
  return rows.map(present);
}

export async function createRunner(
  context: Context,
  userId: string,
  input: { name: string; kind: string; apiKey?: string },
): Promise<RunnerRecord> {
  const { db, clock, runners } = context;
  if (!Object.hasOwn(runners, input.kind)) {
    const kinds = Object.keys(runners);
    throw new ApiError(
      400,
      "unknown_runner_kind",
      `This Cronk has no Runner of the kind ${input.kind}; ${kinds.length ? `it has ${kinds.join(", ")}` : "it has none yet"}.`,
    );
  }
  let managed = null;
  if (input.kind === "managed_agents") {
    if (!input.apiKey?.trim()) {
      throw new ApiError(400, "api_key_required", "A Managed Agents Runner is set up with an Anthropic API key: paste one from the Claude Console.");
    }
    managed = await setUpManagedAgents(context, { name: input.name, apiKey: input.apiKey });
  }
  const { rows } = await db.query<Row>(
    `insert into runners (owner_id, kind, name, created_at, api_key_sealed, managed_agent_id, managed_environment_id)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [userId, input.kind, input.name.trim(), clock.now(), managed?.apiKeySealed ?? null, managed?.agentId ?? null, managed?.environmentId ?? null],
  );
  return (await findRunner(context, userId, rows[0]!.id))!;
}

/** One of the User's own Runners; otherwise nothing, as if it didn't exist. */
export async function findRunner({ db, clock }: Context, userId: string, runnerId: string): Promise<RunnerRecord | undefined> {
  if (!isUuid(runnerId)) return undefined;
  const { rows } = await db.query<Row>(`select ${columns("$3")} from runners where id = $1 and owner_id = $2`, [
    runnerId,
    userId,
    clock.now(),
  ]);
  return rows[0] && present(rows[0]);
}

export const noSuchRunner = () => new ApiError(404, "not_found", "You have no such Runner.");
export const noSuchProject = () => new ApiError(404, "project_not_found", "There is no such Project in your Workspaces.");

/**
 * Saves the trigger a `subscription` Runner fires for a model, for all Projects or overriding that for one Project,
 * replacing the one it had for the same model and Project. The token is sealed under `CRONK_SECRET_KEY` and never returned.
 */
export async function saveTrigger(
  context: Context,
  userId: string,
  runnerId: string,
  input: { model: string; projectId?: string | null; triggerId: string; token: string },
): Promise<RunnerRecord> {
  const runner = await findRunner(context, userId, runnerId);
  if (!runner) throw noSuchRunner();
  if (runner.kind !== "subscription") {
    throw new ApiError(409, "runner_has_no_triggers", `${runner.name} is a Runner of the kind ${runner.kind}, which fires no triggers.`);
  }
  const projectId = input.projectId ?? null;
  if (projectId !== null && !(await findProject(context.db, userViewer(userId), projectId))) {
    throw noSuchProject();
  }
  const sealed = requireSecretBox(context.config).seal(input.token.trim());
  const model = input.model.trim();
  // One trigger per model for the Runner, and per model for each Project: saving again replaces it.
  const conflict = projectId === null ? "(runner_id, lower(model)) where project_id is null" : "(runner_id, project_id, lower(model)) where project_id is not null";
  await context.db.query(
    `insert into runner_triggers (runner_id, project_id, model, trigger_id, token_sealed, created_at)
     values ($1, $2, $3, $4, $5, $6)
     on conflict ${conflict} do update set model = excluded.model, trigger_id = excluded.trigger_id,
       token_sealed = excluded.token_sealed, created_at = excluded.created_at`,
    [runnerId, projectId, model, input.triggerId.trim(), sealed, context.clock.now()],
  );
  return (await findRunner(context, userId, runnerId))!;
}

/**
 * Replaces a Project's triggers on a Runner with new ones, one per model label, each waiting for its token, as a
 * Runner setup leaves them; the Runner's triggers for all Projects stay. Returns them in the order given.
 */
export async function replaceProjectTriggers(
  tx: Tx,
  runnerId: string,
  projectId: string,
  triggers: { model: string; triggerId: string }[],
  now: Date,
): Promise<Trigger[]> {
  await tx.query("delete from runner_triggers where runner_id = $1 and project_id = $2", [runnerId, projectId]);
  const saved: Trigger[] = [];
  for (const { model, triggerId } of triggers) {
    const { rows } = await tx.query<{ trigger: TriggerRow }>(
      `insert into runner_triggers as t (runner_id, project_id, model, trigger_id, token_sealed, created_at)
       values ($1, $2, $3, $4, null, $5) returning ${triggerJson} as trigger`,
      [runnerId, projectId, model, triggerId, now],
    );
    saved.push(presentTrigger(rows[0]!.trigger));
  }
  return saved;
}

/**
 * Pastes the token of one of a Runner's triggers, such as one a Runner setup made, waiting for it, sealed under
 * `CRONK_SECRET_KEY` as saving a trigger seals it, and never returned. Runs that couldn't start for want of it are
 * retried by the User, as any Run that couldn't start.
 */
export async function pasteTriggerToken(
  context: Context,
  userId: string,
  runnerId: string,
  triggerId: string,
  token: string,
): Promise<RunnerRecord> {
  const runner = await findRunner(context, userId, runnerId);
  if (!runner) throw noSuchRunner();
  if (!runner.triggers.some((t) => t.id === triggerId)) throw new ApiError(404, "not_found", `${runner.name} has no such trigger.`);
  const sealed = requireSecretBox(context.config).seal(token.trim());
  await context.db.query("update runner_triggers set token_sealed = $3 where id = $1 and runner_id = $2", [triggerId, runnerId, sealed]);
  return (await findRunner(context, userId, runnerId))!;
}

/** Removes one of a Runner's triggers; Runs needing it then can't start until another is saved. */
export async function removeTrigger(context: Context, userId: string, runnerId: string, triggerId: string): Promise<RunnerRecord> {
  const runner = await findRunner(context, userId, runnerId);
  if (!runner) throw noSuchRunner();
  const { rowCount } = isUuid(triggerId)
    ? await context.db.query("delete from runner_triggers where id = $1 and runner_id = $2", [triggerId, runnerId])
    : { rowCount: 0 };
  if (!rowCount) throw new ApiError(404, "not_found", `${runner.name} has no such trigger.`);
  return (await findRunner(context, userId, runnerId))!;
}

/** Removes one of the User's own Runners with its triggers; Agents pointed at it are left with none. */
export async function removeRunner(context: Context, userId: string, runnerId: string): Promise<void> {
  await transaction(context.db, async (tx) => {
    if (!isUuid(runnerId)) throw noSuchRunner();
    // The Tickets of its running Runs are locked before the Runner, in the order everything that ends a Run locks them.
    const { rows: held } = await tx.query<{ id: string; workspaceId: string; projectId: string }>(
      `select tickets.id, tickets.workspace_id as "workspaceId", tickets.project_id as "projectId"
       from tickets join runs on runs.ticket_id = tickets.id
       join runners on runners.id = runs.runner_id and runners.owner_id = $2
       where runs.runner_id = $1 and runs.state = 'running' order by tickets.id for update of tickets`,
      [runnerId, userId],
    );
    // Locked as starting a Run locks it, so no Run starts on it between the check and the delete.
    const { rows } = await tx.query<{ name: string; kind: string }>(
      "select name, kind from runners where id = $1 and owner_id = $2 for update",
      [runnerId, userId],
    );
    if (!rows[0]) throw noSuchRunner();
    const { name, kind } = rows[0];
    if (context.runners[kind]?.stopsRunsWhenRemoved) {
      // Its Runs stop, as when a User takes their Tickets away: their sessions are stopped and their credentials revoked.
      const now = context.clock.now();
      for (const ticket of held) {
        await stopRunningRun(context, tx, ticket.id, `${name}, the Runner of its Agent, was removed.`, now);
        context.live.publish(tx, ticket.workspaceId, { type: "ticket.changed", projectId: ticket.projectId, ticketId: ticket.id });
      }
    }
    const { rows: counted } = await tx.query<{ running: number }>(
      "select count(*)::int as running from runs where runner_id = $1 and state = 'running'",
      [runnerId],
    );
    const running = counted[0]!.running;
    if (running > 0) {
      throw new ApiError(
        409,
        "runner_running",
        `${name} has ${running === 1 ? "a Run" : `${running} Runs`} running. Wait for its running Runs to end, or stop them first.`,
      );
    }
    // Its Agents' Tickets waiting in its queue are rechecked once it is gone, as for an Agent with no Runner.
    const waiting = await waitingTickets(tx, "agents.runner_id = $1", [runnerId]);
    await tx.query("update agents set runner_id = null where runner_id = $1", [runnerId]);
    // Past Runs keep their history, without the Runner.
    await tx.query("update runs set runner_id = null where runner_id = $1", [runnerId]);
    await tx.query("delete from runners where id = $1", [runnerId]);
    context.live.publishToOwner(tx, userId, { type: "runner.changed", runnerId });
    recheckWaiting(context, tx, waiting.map(({ id }) => ({ id, runnerId: null })));
  });
}

/** A `managed_agents` Runner's budget per Run, in US cents, as the API takes it; null for none. */
export const BudgetPerRun = Type.Union(
  [
    Type.Object({
      amount: Type.Integer({ minimum: 1, maximum: 100_000_000, description: "In US cents: 500 is $5.00." }),
      currency: Type.Literal("USD", { description: "Anthropic budgets sessions in US dollars only." }),
    }),
    Type.Null(),
  ],
  {
    description:
      "For a `managed_agents` Runner, the most each Run may cost at Anthropic's list prices, passed as each session's " +
      "budget: a Run whose session reaches it fails with *budget reached*. Null for none, the default.",
  },
);
export type BudgetPerRun = Static<typeof BudgetPerRun>;

/**
 * Changes one of the User's own Runners: how many Runs it keeps running at once, where a higher limit starts waiting
 * Tickets, and for a `managed_agents` Runner its budget per Run, which Runs started from then on get.
 */
export async function updateRunner(
  context: Context,
  userId: string,
  runnerId: string,
  input: { limit?: number; budgetPerRun?: BudgetPerRun },
): Promise<RunnerRecord> {
  return transaction(context.db, async (tx) => {
    const { rows: found } = isUuid(runnerId)
      ? await tx.query<{ name: string; kind: string }>("select name, kind from runners where id = $1 and owner_id = $2 for update", [
          runnerId,
          userId,
        ])
      : { rows: [] };
    const runner = found[0];
    if (!runner) throw noSuchRunner();
    if (input.budgetPerRun !== undefined && runner.kind !== "managed_agents") {
      throw new ApiError(
        409,
        "runner_has_no_budget",
        `${runner.name} is a Runner of the kind ${runner.kind}, which reports no cost to budget: only a Managed Agents Runner has a budget per Run.`,
      );
    }
    const { rows } = await tx.query<Row>(
      `update runners set run_limit = coalesce($3, run_limit),
         budget_per_run = case when $4::boolean then $5::integer else budget_per_run end
       where id = $1 and owner_id = $2 returning ${columns("$6")}`,
      [runnerId, userId, input.limit ?? null, input.budgetPerRun !== undefined, input.budgetPerRun?.amount ?? null, context.clock.now()],
    );
    if (input.limit !== undefined) afterCommit(tx, () => startWaitingRuns(context, runnerId));
    return present(rows[0]!);
  });
}
