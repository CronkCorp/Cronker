import { Type, type Static } from "typebox";
import type { Clock } from "../clock.js";
import type { Context } from "../context.js";
import { violates, type Db } from "../db.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import { User } from "../identity/user.js";
import { startWaitingRuns } from "../runs/runs.js";

/** A non-human account acting in one Workspace on behalf of exactly one User, its Owner. */
export const Agent = Type.Object({
  id: Type.String({ format: "uuid" }),
  workspaceId: Type.String({ format: "uuid" }),
  name: Type.String(),
  owner: User,
  runnerId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
    description: "The Owner's Runner the Agent's Runs start through; none yet means its Runs are refused.",
  }),
  createdAt: Type.String({ format: "date-time" }),
});
export type Agent = Static<typeof Agent>;

export const AgentName = Type.String({
  minLength: 1,
  maxLength: 100,
  pattern: "\\S",
  description: "Unique among the Workspace's Agents, ignoring case.",
});

type Row = Omit<Agent, "createdAt"> & { createdAt: Date };

const columns = `agents.id, agents.workspace_id as "workspaceId", agents.name,
  json_build_object('id', owners.id, 'email', owners.email, 'githubLogin', owners.github_login) as owner,
  agents.runner_id as "runnerId", agents.created_at as "createdAt"`;

const present = (row: Row): Agent => ({ ...row, createdAt: row.createdAt.toISOString() });

const nameTaken = (name: string) =>
  new ApiError(409, "agent_name_taken", `This Workspace already has an Agent named ${name}. Choose another name.`);

/** The Workspace's Agents still in use, of every member. */
export async function agentsOf(db: Db, workspaceId: string): Promise<Agent[]> {
  const { rows } = await db.query<Row>(
    `select ${columns} from agents join users owners on owners.id = agents.owner_id
     where agents.workspace_id = $1 and agents.removed_at is null
     order by lower(agents.name), agents.id`,
    [workspaceId],
  );
  return rows.map(present);
}

export async function createAgent(
  db: Db,
  clock: Clock,
  ownerId: string,
  workspaceId: string,
  name: string,
): Promise<Agent> {
  try {
    const { rows } = await db.query<{ id: string }>(
      "insert into agents (workspace_id, owner_id, name, created_at) values ($1, $2, $3, $4) returning id",
      [workspaceId, ownerId, name.trim(), clock.now()],
    );
    return (await findAgent(db, rows[0]!.id))!;
  } catch (error) {
    if (violates(error, "agents_workspace_name_key")) throw nameTaken(name.trim());
    throw error;
  }
}

/** An Agent still in use, by id. */
export async function findAgent(db: Db, agentId: string): Promise<Agent | undefined> {
  if (!isUuid(agentId)) return undefined;
  const { rows } = await db.query<Row>(
    `select ${columns} from agents join users owners on owners.id = agents.owner_id
     where agents.id = $1 and agents.removed_at is null`,
    [agentId],
  );
  return rows[0] && present(rows[0]);
}

/**
 * The User's own Agent: 404 if it isn't in a Workspace they belong to (as if it didn't
 * exist), 403 if it is someone else's.
 */
export async function requireOwnAgent(db: Db, userId: string, agentId: string): Promise<Agent> {
  const agent = await findAgent(db, agentId);
  const { rowCount } = agent
    ? await db.query("select 1 from memberships where workspace_id = $1 and user_id = $2", [agent.workspaceId, userId])
    : { rowCount: 0 };
  if (!agent || rowCount === 0) throw new ApiError(404, "not_found", "No such Agent.");
  if (agent.owner.id !== userId) {
    throw new ApiError(403, "not_owner", `Only ${agent.name}'s Owner, ${agent.owner.email ?? `@${agent.owner.githubLogin}`}, can change it.`);
  }
  return agent;
}

export async function renameAgent(db: Db, agent: Agent, name: string): Promise<Agent> {
  try {
    await db.query("update agents set name = $2 where id = $1", [agent.id, name.trim()]);
  } catch (error) {
    if (violates(error, "agents_workspace_name_key")) throw nameTaken(name.trim());
    throw error;
  }
  return { ...agent, name: name.trim() };
}

/** Points the Agent at one of its Owner's Runners, or at none. */
/** Points the Agent at one of its Owner's Runners, or none; Tickets waiting on it take that Runner's free slots. */
export async function setAgentRunner(context: Context, agent: Agent, runnerId: string | null): Promise<Agent> {
  const { db } = context;
  if (runnerId !== null) {
    const { rowCount } = await db.query("select 1 from runners where id = $1 and owner_id = $2", [runnerId, agent.owner.id]);
    if (rowCount === 0) throw new ApiError(400, "unknown_runner", "An Agent uses only one of its Owner's own Runners.");
  }
  await db.query("update agents set runner_id = $2 where id = $1", [agent.id, runnerId]);
  if (runnerId !== null) await startWaitingRuns(context, runnerId);
  return { ...agent, runnerId };
}

/** Removes an Agent: it no longer lists and its tokens are refused at once; what it did still names it. */
export async function removeAgent(db: Db, clock: Clock, agent: Agent): Promise<void> {
  await db.query("update agents set removed_at = $2 where id = $1 and removed_at is null", [agent.id, clock.now()]);
}
