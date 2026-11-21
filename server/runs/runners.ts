import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { afterCommit, transaction, type Db } from "../db.js";
import { requireSecretBox } from "../encryption.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import { userViewer } from "../identity/viewers.js";
import { findProject } from "../work/projects.js";
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
  createdAt: Type.String({ format: "date-time" }),
});
export type Trigger = Static<typeof Trigger>;

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
  createdAt: Type.String({ format: "date-time" }),
});
export type RunnerRecord = Static<typeof RunnerRecord>;

type TriggerRow = Omit<Trigger, "createdAt"> & { createdAt: string };
type Row = Omit<RunnerRecord, "createdAt" | "pausedUntil" | "triggers"> & {
  createdAt: Date;
  pausedUntil: Date | null;
  triggers: TriggerRow[];
};
const triggerJson = `json_build_object('id', t.id, 'model', t.model, 'projectId', t.project_id, 'triggerId', t.trigger_id,
  'createdAt', t.created_at)`;
const columns = `id, name, kind, run_limit as limit,
  (select count(*)::int from runs where runs.runner_id = runners.id and runs.state = 'running') as running,
  paused_until as "pausedUntil", created_at as "createdAt",
  case when kind = 'managed_agents' then json_build_object('agentId', managed_agent_id, 'environmentId', managed_environment_id)
  end as "managedAgents",
  coalesce((select json_agg(${triggerJson} order by t.project_id nulls first, lower(t.model), t.created_at)
    from runner_triggers t where t.runner_id = runners.id), '[]') as triggers`;
const present = (row: Row): RunnerRecord => ({
  ...row,
  pausedUntil: row.pausedUntil?.toISOString() ?? null,
  triggers: row.triggers.map((t) => ({ ...t, createdAt: new Date(t.createdAt).toISOString() })),
  createdAt: row.createdAt.toISOString(),
});

/** The User's own Runners, oldest first. */
export async function runnersOf(db: Db, userId: string): Promise<RunnerRecord[]> {
  const { rows } = await db.query<Row>(`select ${columns} from runners where owner_id = $1 order by created_at, id`, [userId]);
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
  return (await findRunner(db, userId, rows[0]!.id))!;
}

/** One of the User's own Runners; otherwise nothing, as if it didn't exist. */
async function findRunner(db: Db, userId: string, runnerId: string): Promise<RunnerRecord | undefined> {
  if (!isUuid(runnerId)) return undefined;
  const { rows } = await db.query<Row>(`select ${columns} from runners where id = $1 and owner_id = $2`, [runnerId, userId]);
  return rows[0] && present(rows[0]);
}

const noSuchRunner = () => new ApiError(404, "not_found", "You have no such Runner.");

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
  const runner = await findRunner(context.db, userId, runnerId);
  if (!runner) throw noSuchRunner();
  if (runner.kind !== "subscription") {
    throw new ApiError(409, "runner_has_no_triggers", `${runner.name} is a Runner of the kind ${runner.kind}, which fires no triggers.`);
  }
  const projectId = input.projectId ?? null;
  if (projectId !== null && !(await findProject(context.db, userViewer(userId), projectId))) {
    throw new ApiError(404, "project_not_found", "There is no such Project in your Workspaces.");
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
  return (await findRunner(context.db, userId, runnerId))!;
}

/** Removes one of a Runner's triggers; Runs needing it then can't start until another is saved. */
export async function removeTrigger(context: Context, userId: string, runnerId: string, triggerId: string): Promise<RunnerRecord> {
  const runner = await findRunner(context.db, userId, runnerId);
  if (!runner) throw noSuchRunner();
  const { rowCount } = isUuid(triggerId)
    ? await context.db.query("delete from runner_triggers where id = $1 and runner_id = $2", [triggerId, runnerId])
    : { rowCount: 0 };
  if (!rowCount) throw new ApiError(404, "not_found", `${runner.name} has no such trigger.`);
  return (await findRunner(context.db, userId, runnerId))!;
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

/** Sets how many Runs one of the User's own Runners keeps running at once; a higher limit starts waiting Tickets. */
export async function setRunnerLimit(context: Context, userId: string, runnerId: string, limit: number): Promise<RunnerRecord> {
  return transaction(context.db, async (tx) => {
    const { rows } = isUuid(runnerId)
      ? await tx.query<Row>(`update runners set run_limit = $3 where id = $1 and owner_id = $2 returning ${columns}`, [
          runnerId,
          userId,
          limit,
        ])
      : { rows: [] };
    if (!rows[0]) throw noSuchRunner();
    afterCommit(tx, () => startWaitingRuns(context, runnerId));
    return present(rows[0]);
  });
}
