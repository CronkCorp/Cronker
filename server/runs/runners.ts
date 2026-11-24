import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { afterCommit, transaction, type Tx } from "../db.js";
import { requireSecretBox } from "../encryption.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import { userViewer } from "../identity/viewers.js";
import { findProject } from "../work/projects.js";
import { ModelLabel } from "../workspaces/model-ids.js";
import { Cost, costTotalsSql } from "./costs.js";
import { defaultAllowedTools } from "./allowlist.js";
import { runsInCloud } from "./runner.js";
import { managedAgentsWebhookUrl, setUpManagedAgents } from "./managed-agents.js";
import { recheckWaiting, startWaitingRuns, stopRunningRun, waitingTickets, type WaitingTicket } from "./runs.js";
import { runnerOffline } from "./waiting.js";

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
      "Saved without its token, or made by a Runner setup, and waiting for the token its Owner generates in claude.ai " +
      "and pastes; Runs needing it can't start until then.",
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
  cloud: Type.Boolean({
    description:
      "Whether its kind runs Runs in the cloud, as `subscription` and `managed_agents` do: a Ticket labelled " +
      "`local-only` gets no Run through it. False for `local`, whose Runs run on its Owner's own Machines, and for a kind this Cronk lacks.",
  }),
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
  offlineSince: Type.Union([Type.String({ format: "date-time" }), Type.Null()], {
    description:
      "For a `local` Runner while no Machine serving it is connected: since when, the moment its last Machine's " +
      "stream closed, or when it was set up if none ever connected. Its Tickets wait meanwhile, refusing nothing, " +
      "and start, highest Priority first, once one connects. Null while one is connected, and for other kinds.",
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
        webhookUrl: Type.String({
          format: "uri",
          description: "The webhook endpoint URL to add in the Anthropic Console, for the session events that end Runs at once.",
        }),
        webhookSecretSaved: Type.Boolean({
          description: "Whether the endpoint's signing secret is saved; without one, Runs end only by polling.",
        }),
      }),
      Type.Null(),
    ],
    { description: "For a `managed_agents` Runner, what Cronk created with its API key; null for other kinds." },
  ),
  budgetPerRun: BudgetPerRunField,
  allowedTools: Type.Union([Type.Array(Type.String()), Type.Null()], {
    description:
      "For a `local` Runner, its allowlist: the Claude Code permission rules, such as `Bash(git:*)`, for the tools its " +
      "Runs may use without asking, passed to `claude` as `--allowedTools` with `--permission-mode acceptEdits`. Cronk's " +
      "own MCP tools (`mcp__cronk`) are always allowed. Null for other kinds.",
  }),
  costThisMonth: Type.Array(Cost, {
    description:
      "What its Runs that ended this calendar month (in UTC) cost, one total per currency, real costs apart from " +
      "estimates (`estimate`, as a `local` Runner's Runs report); empty when none reported a cost, as cloud " +
      "subscription Runs don't.",
  }),
  createdAt: Type.String({ format: "date-time" }),
});
export type RunnerRecord = Static<typeof RunnerRecord>;

type TriggerRow = Omit<Trigger, "createdAt" | "routineUrl"> & { createdAt: string };
type Row = Omit<RunnerRecord, "createdAt" | "pausedUntil" | "offlineSince" | "triggers" | "managedAgents" | "cloud"> & {
  managedAgents: Omit<NonNullable<RunnerRecord["managedAgents"]>, "webhookUrl"> | null;
  createdAt: Date;
  pausedUntil: Date | null;
  offlineSince: Date | null;
  triggers: TriggerRow[];
};
const triggerJson = `json_build_object('id', t.id, 'model', t.model, 'projectId', t.project_id, 'triggerId', t.trigger_id,
  'waitingForToken', t.token_sealed is null, 'createdAt', t.created_at)`;
/** The Runners' columns, given the placeholder of the current time, which sets the month `costThisMonth` totals. */
const columns = (now: string) => `id, name, kind, run_limit as limit,
  (select count(*)::int from runs where runs.runner_id = runners.id and runs.state = 'running') as running,
  paused_until as "pausedUntil", created_at as "createdAt",
  case when ${runnerOffline("runners")} then greatest(runners.created_at, (select max(machines.disconnected_at)
    from machine_runners join machines on machines.id = machine_runners.machine_id where machine_runners.runner_id = runners.id))
  end as "offlineSince",
  case when kind = 'managed_agents' then json_build_object('agentId', managed_agent_id, 'environmentId', managed_environment_id,
    'webhookSecretSaved', webhook_secret_sealed is not null)
  end as "managedAgents",
  case when budget_per_run is not null then json_build_object('amount', budget_per_run, 'currency', 'USD') end
    as "budgetPerRun",
  allowed_tools as "allowedTools",
  ${costTotalsSql(`runs.runner_id = runners.id and runs.ended_at >= date_trunc('month', ${now}::timestamptz, 'UTC')`)}
    as "costThisMonth",
  coalesce((select json_agg(${triggerJson} order by t.project_id nulls first, lower(t.model), t.created_at)
    from runner_triggers t where t.runner_id = runners.id), '[]') as triggers`;
const present = (context: Context, row: Row): RunnerRecord => ({
  ...row,
  cloud: runsInCloud(context.runners, row.kind),
  managedAgents: row.managedAgents && { ...row.managedAgents, webhookUrl: managedAgentsWebhookUrl(context, row.id) },
  pausedUntil: row.pausedUntil?.toISOString() ?? null,
  offlineSince: row.offlineSince?.toISOString() ?? null,
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
export async function runnersOf(context: Context, userId: string): Promise<RunnerRecord[]> {
  const { rows } = await context.db.query<Row>(`select ${columns("$2")} from runners where owner_id = $1 order by created_at, id`, [
    userId,
    context.clock.now(),
  ]);
  return rows.map((row) => present(context, row));
}

/** The set-up-a-Runner route's body. */
export const RunnerCreate = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100, pattern: "\\S" }),
  kind: Type.String({ minLength: 1, maxLength: 50 }),
  apiKey: Type.Optional(
    Type.String({ maxLength: 1000, description: "For a `managed_agents` Runner: the Anthropic API key its Runs spend." }),
  ),
});
export type RunnerCreate = Static<typeof RunnerCreate>;

export async function createRunner(
  context: Context,
  userId: string,
  input: RunnerCreate,
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
    `insert into runners (owner_id, kind, name, created_at, api_key_sealed, managed_agent_id, managed_environment_id, allowed_tools)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [
      userId,
      input.kind,
      input.name.trim(),
      clock.now(),
      managed?.apiKeySealed ?? null,
      managed?.agentId ?? null,
      managed?.environmentId ?? null,
      input.kind === "local" ? [...defaultAllowedTools] : null,
    ],
  );
  return (await findRunner(context, userId, rows[0]!.id))!;
}

/** One of the User's own Runners; otherwise nothing, as if it didn't exist. */
export async function findRunner(context: Context, userId: string, runnerId: string): Promise<RunnerRecord | undefined> {
  if (!isUuid(runnerId)) return undefined;
  const { rows } = await context.db.query<Row>(`select ${columns("$3")} from runners where id = $1 and owner_id = $2`, [
    runnerId,
    userId,
    context.clock.now(),
  ]);
  return rows[0] && present(context, rows[0]);
}

export const noSuchRunner = () => new ApiError(404, "not_found", "You have no such Runner.");
export const noSuchProject = () => new ApiError(404, "project_not_found", "There is no such Project in your Workspaces.");

/**
 * Saves the trigger a `subscription` Runner fires for a model, for all Projects or overriding that for one Project,
 * replacing the one it had for the same model and Project. The token is sealed under `CRONK_SECRET_KEY` and never returned;
 * without one, the trigger keeps the token it had under the same trigger id, or else waits for its token.
 */
/** A routine's trigger id, as claude.ai shows it. */
export const TriggerId = Type.String({ minLength: 1, maxLength: 200, pattern: "^\\s*[A-Za-z0-9_-]+\\s*$" });

/** The save-a-trigger route's body. */
export const TriggerSave = Type.Object({
  model: ModelLabel,
  projectId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
  triggerId: TriggerId,
  token: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 1000,
      pattern: "\\S",
      description: "The trigger's token; leave it out to save the trigger waiting for it.",
    }),
  ),
});
export type TriggerSave = Static<typeof TriggerSave>;

export async function saveTrigger(
  context: Context,
  userId: string,
  runnerId: string,
  input: TriggerSave,
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
  const sealed = input.token === undefined ? null : requireSecretBox(context.config).seal(input.token.trim());
  const model = input.model.trim();
  // One trigger per model for the Runner, and per model for each Project: saving again replaces it. Saved again
  // without a token, the same trigger id keeps the token it has, so a working trigger isn't left waiting by mistake.
  const conflict = projectId === null ? "(runner_id, lower(model)) where project_id is null" : "(runner_id, project_id, lower(model)) where project_id is not null";
  await context.db.query(
    `insert into runner_triggers (runner_id, project_id, model, trigger_id, token_sealed, created_at)
     values ($1, $2, $3, $4, $5, $6)
     on conflict ${conflict} do update set model = excluded.model, trigger_id = excluded.trigger_id,
       token_sealed = coalesce(excluded.token_sealed,
         case when runner_triggers.trigger_id = excluded.trigger_id then runner_triggers.token_sealed end),
       created_at = excluded.created_at`,
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
 * Pastes the token into one of a `subscription` Runner's triggers, such as one saved without it or made by a Runner setup,
 * waiting for it, replacing any it had. It is sealed under `CRONK_SECRET_KEY` as saving a trigger seals it, and never
 * returned. Pasted into a trigger waiting for it, the Tickets whose Runs couldn't start for want of it are rechecked; a
 * token replacing a working one leaves them to Retry.
 */
/** The paste-a-trigger's-token route's body. */
export const TriggerToken = Type.Object({ token: Type.String({ minLength: 1, maxLength: 1000, pattern: "\\S" }) });
export type TriggerToken = Static<typeof TriggerToken>;

export async function pasteTriggerToken(
  context: Context,
  userId: string,
  runnerId: string,
  triggerId: string,
  token: string,
): Promise<RunnerRecord> {
  const runner = await findRunner(context, userId, runnerId);
  if (!runner) throw noSuchRunner();
  const sealed = requireSecretBox(context.config).seal(token.trim());
  await transaction(context.db, async (tx) => {
    const { rows } = isUuid(triggerId)
      ? await tx.query<PastedTrigger & { waited: boolean }>(
          `select runner_id as "runnerId", model, project_id as "projectId", token_sealed is null as waited
           from runner_triggers where id = $1 and runner_id = $2 for update`,
          [triggerId, runnerId],
        )
      : { rows: [] };
    const trigger = rows[0];
    if (!trigger) throw new ApiError(404, "not_found", `${runner.name} has no such trigger.`);
    await tx.query("update runner_triggers set token_sealed = $2 where id = $1", [triggerId, sealed]);
    if (trigger.waited) await recheckCouldntStart(context, tx, trigger);
  });
  return (await findRunner(context, userId, runnerId))!;
}

/** A trigger whose token was just pasted: whose Runner, for which model and Project. */
interface PastedTrigger {
  runnerId: string;
  model: string;
  projectId: string | null;
}

/**
 * Once the transaction commits, rechecks the Tickets whose latest Run couldn't start where that Run would now fire this
 * trigger, as Retry would: a Ticket of the Runner's Agents, still in that Run's Status, whose Run wanted the trigger's
 * model on its Project (for a trigger for all Projects, one without its own trigger for the model).
 */
async function recheckCouldntStart(context: Context, tx: Tx, trigger: PastedTrigger): Promise<void> {
  const { rows } = await tx.query<WaitingTicket>(
    `select tickets.id, agents.runner_id as "runnerId"
     from tickets join agents on agents.id = tickets.delegate_id
     join lateral (select state, status_id, model from runs where runs.ticket_id = tickets.id order by seq desc limit 1) latest on true
     where agents.runner_id = $1 and latest.state = 'refused' and latest.status_id = tickets.status_id
       and lower(latest.model) = lower($2)
       and (tickets.project_id = $3 or ($3::uuid is null and not exists (
         select 1 from runner_triggers own where own.runner_id = $1 and own.project_id = tickets.project_id
           and lower(own.model) = lower($2))))`,
    [trigger.runnerId, trigger.model, trigger.projectId],
  );
  recheckWaiting(context, tx, rows);
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

/**
 * Saves the signing secret of a `managed_agents` Runner's webhook endpoint, as the Anthropic Console shows it once,
 * sealed under `CRONK_SECRET_KEY` and never returned, replacing any saved before.
 */
/** The save-the-webhook-secret route's body. */
export const WebhookSecret = Type.Object({ secret: Type.String({ minLength: 1, maxLength: 200 }) });
export type WebhookSecret = Static<typeof WebhookSecret>;

export async function saveWebhookSecret(context: Context, userId: string, runnerId: string, secret: string): Promise<RunnerRecord> {
  const trimmed = secret.trim();
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    throw new ApiError(400, "invalid_webhook_secret", "A webhook signing secret starts with `whsec_`: copy it from the endpoint in the Anthropic Console.");
  }
  return setWebhookSecret(context, userId, runnerId, () => requireSecretBox(context.config).seal(trimmed));
}

/** Forgets a `managed_agents` Runner's webhook signing secret, so its deliveries are refused and Runs end by polling alone. */
export async function forgetWebhookSecret(context: Context, userId: string, runnerId: string): Promise<RunnerRecord> {
  return setWebhookSecret(context, userId, runnerId, () => null);
}

async function setWebhookSecret(
  context: Context,
  userId: string,
  runnerId: string,
  sealed: () => string | null,
): Promise<RunnerRecord> {
  const runner = await findRunner(context, userId, runnerId);
  if (!runner) throw noSuchRunner();
  if (runner.kind !== "managed_agents") {
    throw new ApiError(409, "runner_has_no_webhook", `${runner.name} is a Runner of the kind ${runner.kind}, which takes no webhooks.`);
  }
  await context.db.query("update runners set webhook_secret_sealed = $2 where id = $1", [runnerId, sealed()]);
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

/** A `local` Runner's allowlist as the API takes it. */
export const AllowedTools = Type.Union(
  [Type.Array(Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" }), { maxItems: 200 }), Type.Null()],
  {
    description:
      "For a `local` Runner, the Claude Code permission rules, such as `Bash(git:*)`, for the tools its Runs may use " +
      "without asking; trimmed, with repeats dropped. Null resets it to the default a new `local` Runner gets. It " +
      "applies to Runs claimed from then on.",
  },
);

/** The change-a-Runner route's body: whichever of its limit, budget per Run and allowlist are given, at least one. */
export const RunnerEdit = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    budgetPerRun: Type.Optional(BudgetPerRun),
    allowedTools: Type.Optional(AllowedTools),
  },
  { minProperties: 1 },
);
export type RunnerEdit = Static<typeof RunnerEdit>;

/**
 * Changes one of the User's own Runners: how many Runs it keeps running at once, where a higher limit starts waiting
 * Tickets, for a `managed_agents` Runner its budget per Run, which Runs started from then on get, and for a `local`
 * Runner its allowlist, which Runs claimed from then on get.
 */
export async function updateRunner(
  context: Context,
  userId: string,
  runnerId: string,
  input: RunnerEdit,
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
    if (input.allowedTools !== undefined && runner.kind !== "local") {
      throw new ApiError(
        409,
        "runner_has_no_allowlist",
        `${runner.name} is a Runner of the kind ${runner.kind}, whose Runs don't run on your Machines: only a local Runner has an allowlist.`,
      );
    }
    const allowedTools =
      input.allowedTools === null ? [...defaultAllowedTools] : input.allowedTools && [...new Set(input.allowedTools.map((rule) => rule.trim()))];
    const { rows } = await tx.query<Row>(
      `update runners set run_limit = coalesce($3, run_limit),
         budget_per_run = case when $4::boolean then $5::integer else budget_per_run end,
         allowed_tools = coalesce($7::text[], allowed_tools)
       where id = $1 and owner_id = $2 returning ${columns("$6")}`,
      [
        runnerId,
        userId,
        input.limit ?? null,
        input.budgetPerRun !== undefined,
        input.budgetPerRun?.amount ?? null,
        context.clock.now(),
        allowedTools ?? null,
      ],
    );
    if (input.limit !== undefined) afterCommit(tx, () => startWaitingRuns(context, runnerId));
    return present(context, rows[0]!);
  });
}
