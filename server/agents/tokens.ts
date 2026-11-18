import type { FastifyRequest } from "fastify";
import { Type, type Static } from "typebox";
import type { Clock } from "../clock.js";
import type { Context } from "../context.js";
import type { Db } from "../db.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import { hashSecret, issueSecret } from "../identity/secrets.js";
import type { User } from "../identity/user.js";
import type { Workspace } from "../workspaces/workspaces.js";
import type { Agent } from "./agents.js";

/**
 * Agent tokens: a full token acts as its Agent, a read-only one may only read. The
 * secret is shown once, when issued; Cronk keeps only its hash. Revoking a token,
 * removing its Agent or its Owner leaving the Workspace refuses it from the next request.
 */

export const TokenAccess = Type.Union([Type.Literal("full"), Type.Literal("read")], {
  description: "`full` acts as the Agent; `read` may only read.",
});
export type TokenAccess = Static<typeof TokenAccess>;

export const AgentToken = Type.Object({
  id: Type.String({ format: "uuid" }),
  name: Type.String(),
  access: TokenAccess,
  createdAt: Type.String({ format: "date-time" }),
});
export type AgentToken = Static<typeof AgentToken>;

export const IssuedToken = Type.Object({
  token: AgentToken,
  secret: Type.String({ description: "The token to send as `Authorization: Bearer …`. Shown only this once." }),
});
export type IssuedToken = Static<typeof IssuedToken>;

/** An Agent making a request with one of its tokens. */
export interface AgentCaller {
  kind: "agent";
  id: string;
  name: string;
  workspace: Workspace;
  owner: User;
  access: TokenAccess;
}

type Row = Omit<AgentToken, "createdAt"> & { createdAt: Date };
const columns = `id, name, access, created_at as "createdAt"`;
const present = (row: Row): AgentToken => ({ ...row, createdAt: row.createdAt.toISOString() });

export async function tokensOf(db: Db, agent: Agent): Promise<AgentToken[]> {
  const { rows } = await db.query<Row>(
    `select ${columns} from agent_tokens where agent_id = $1 order by created_at, id`,
    [agent.id],
  );
  return rows.map(present);
}

export async function issueToken(
  db: Db,
  clock: Clock,
  agent: Agent,
  input: { name: string; access: TokenAccess },
): Promise<IssuedToken> {
  const secret = issueSecret("agent");
  const { rows } = await db.query<Row>(
    `insert into agent_tokens (agent_id, name, access, token_hash, created_at) values ($1, $2, $3, $4, $5)
     returning ${columns}`,
    [agent.id, input.name.trim(), input.access, hashSecret(secret), clock.now()],
  );
  return { token: present(rows[0]!), secret };
}

export async function revokeToken(db: Db, agent: Agent, tokenId: string): Promise<void> {
  const { rowCount } = isUuid(tokenId)
    ? await db.query("delete from agent_tokens where id = $1 and agent_id = $2", [tokenId, agent.id])
    : { rowCount: 0 };
  if (rowCount === 0) throw new ApiError(404, "not_found", "No such token of this Agent.");
}

const safeMethods = new Set(["GET", "HEAD"]);

/**
 * The Agent whose token the request carries as `Authorization: Bearer …`, or nothing if it
 * carries none. Refuses a token that was revoked, whose Agent was removed or whose Owner has
 * left the Workspace, and a read-only token on a request that would change something.
 */
export async function authenticateAgent({ db }: Context, request: FastifyRequest): Promise<AgentCaller | undefined> {
  const header = request.headers.authorization;
  if (header === undefined) return undefined;
  const secret = /^Bearer\s+(\S+)\s*$/i.exec(header)?.[1];
  const { rows } = secret
    ? await db.query<AgentCaller>(
        `select 'agent' as kind, agents.id, agents.name, agent_tokens.access,
           json_build_object('id', workspaces.id, 'name', workspaces.name) as workspace,
           json_build_object('id', owners.id, 'email', owners.email) as owner
         from agent_tokens
         join agents on agents.id = agent_tokens.agent_id and agents.removed_at is null
         join memberships on memberships.workspace_id = agents.workspace_id and memberships.user_id = agents.owner_id
         join workspaces on workspaces.id = agents.workspace_id
         join users owners on owners.id = agents.owner_id
         where agent_tokens.token_hash = $1`,
        [hashSecret(secret)],
      )
    : { rows: [] };
  const agent = rows[0];
  if (!agent) {
    throw new ApiError(401, "invalid_token", "That token was revoked, its Agent removed, or it never existed.", {
      rule: "Only a current token of an Agent still in use, whose Owner still belongs to its Workspace, is accepted.",
      advice: "Ask the Agent's Owner to issue a new token.",
    });
  }
  if (agent.access === "read" && !safeMethods.has(request.method)) {
    throw new ApiError(403, "read_only_token", `This token of ${agent.name} is read-only.`, {
      rule: "A read-only token may only read.",
      advice: `Read instead, or ask ${agent.owner.email}, ${agent.name}'s Owner, for a full token.`,
    });
  }
  return agent;
}
