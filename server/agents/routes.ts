import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { ApiError, ErrorBody } from "../http/errors.js";
import { requireCaller } from "../identity/callers.js";
import { requireUser } from "../identity/sign-ins.js";
import { requireMember } from "../workspaces/members.js";
import { findWorkspace, Workspace } from "../workspaces/workspaces.js";
import {
  Agent,
  AgentName,
  agentsOf,
  createAgent,
  findAgent,
  removeAgent,
  renameAgent,
  requireOwnAgent,
  setAgentRunner,
} from "./agents.js";
import { AgentToken, IssuedToken, issueToken, revokeToken, TokenAccess, tokensOf } from "./tokens.js";

export function agentRoutes(context: Context): FastifyPluginAsyncTypebox {
  const { db, clock } = context;
  return async (app) => {
    app.get(
      "/api/workspaces/:workspaceId/agents",
      {
        schema: {
          tags: ["Agents"],
          summary: "The Workspace's Agents",
          description: "Every member's Agents, by name. Agents may list their own Workspace's.",
          params: Type.Object({ workspaceId: Type.String() }),
          response: { 200: Type.Array(Agent), 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const caller = await requireCaller(context, request);
        const workspace = await findWorkspace(db, caller, request.params.workspaceId);
        if (!workspace) throw new ApiError(404, "not_found", "No such Workspace.");
        return agentsOf(db, workspace.id);
      },
    );

    app.post(
      "/api/workspaces/:workspaceId/agents",
      {
        schema: {
          tags: ["Agents"],
          summary: "Create an Agent of one's own",
          description: "The signed-in User becomes the Agent's Owner. Refused with `agent_name_taken` if the Workspace has an Agent of that name.",
          params: Type.Object({ workspaceId: Type.String() }),
          body: Type.Object({ name: AgentName }),
          response: { 201: Agent, 400: ErrorBody, 401: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request, reply) => {
        const user = await requireUser(context, request);
        const workspace = await requireMember(db, user.id, request.params.workspaceId);
        return reply.code(201).send(await createAgent(db, clock, user.id, workspace.id, request.body.name));
      },
    );

    const AgentParams = Type.Object({ agentId: Type.String() });

    app.patch(
      "/api/agents/:agentId",
      {
        schema: {
          tags: ["Agents"],
          summary: "Rename one's own Agent, or choose its Runner",
          description:
            "Changes whichever of name and Runner are given. Only the Agent's Owner can change it (`not_owner` otherwise), " +
            "and only to one of their own Runners (`unknown_runner` otherwise).",
          params: AgentParams,
          body: Type.Object({
            name: Type.Optional(AgentName),
            runnerId: Type.Optional(Type.Union([Type.Null(), Type.String({ format: "uuid" })])),
          }),
          response: { 200: Agent, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        let agent = await requireOwnAgent(db, user.id, request.params.agentId);
        const { name, runnerId } = request.body;
        if (name !== undefined) agent = await renameAgent(db, agent, name);
        if (runnerId !== undefined) agent = await setAgentRunner(db, agent, runnerId);
        return agent;
      },
    );

    app.delete(
      "/api/agents/:agentId",
      {
        schema: {
          tags: ["Agents"],
          summary: "Remove one's own Agent",
          description:
            "Its tokens are refused at once. What it did still shows its name. Only the Agent's Owner can remove it (`not_owner` otherwise).",
          params: AgentParams,
          response: { 204: Type.Null(), 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
        },
      },
      async (request, reply) => {
        const user = await requireUser(context, request);
        const agent = await requireOwnAgent(db, user.id, request.params.agentId);
        await removeAgent(db, clock, agent);
        return reply.code(204).send(null);
      },
    );

    app.get(
      "/api/agents/:agentId/tokens",
      {
        schema: {
          tags: ["Agents"],
          summary: "One's own Agent's tokens",
          description: "Never their secrets, which are shown only when issued. Only the Agent's Owner sees them.",
          params: AgentParams,
          response: { 200: Type.Array(AgentToken), 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        return tokensOf(db, await requireOwnAgent(db, user.id, request.params.agentId));
      },
    );

    app.post(
      "/api/agents/:agentId/tokens",
      {
        schema: {
          tags: ["Agents"],
          summary: "Issue a token for one's own Agent",
          description:
            "A full token acts as the Agent; a read-only one may only read. The secret is in this response only: Cronk keeps just its hash.",
          params: AgentParams,
          body: Type.Object({
            name: Type.String({ minLength: 1, maxLength: 100, pattern: "\\S", description: "Where it's used, such as `laptop`." }),
            access: TokenAccess,
          }),
          response: { 201: IssuedToken, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
        },
      },
      async (request, reply) => {
        const user = await requireUser(context, request);
        const agent = await requireOwnAgent(db, user.id, request.params.agentId);
        return reply.code(201).send(await issueToken(db, clock, agent, request.body));
      },
    );

    app.delete(
      "/api/agents/:agentId/tokens/:tokenId",
      {
        schema: {
          tags: ["Agents"],
          summary: "Revoke a token of one's own Agent",
          description: "The token is refused from the next request.",
          params: Type.Object({ agentId: Type.String(), tokenId: Type.String() }),
          response: { 204: Type.Null(), 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
        },
      },
      async (request, reply) => {
        const user = await requireUser(context, request);
        const agent = await requireOwnAgent(db, user.id, request.params.agentId);
        await revokeToken(db, agent, request.params.tokenId);
        return reply.code(204).send(null);
      },
    );

    app.get(
      "/api/agent",
      {
        schema: {
          tags: ["Agents"],
          summary: "The Agent a token belongs to",
          description: "For an Agent: who it is, its Workspace, and whether its token is full or read-only.",
          response: {
            200: Type.Object({ agent: Agent, workspace: Workspace, access: TokenAccess }),
            401: ErrorBody,
            403: ErrorBody,
          },
        },
      },
      async (request) => {
        const caller = await requireCaller(context, request);
        if (caller.kind !== "agent") {
          throw new ApiError(403, "not_an_agent", "Only an Agent's token can ask which Agent it is. Users see themselves at /api/me.");
        }
        // Removed since its token was checked: refused like any token of a removed Agent.
        const agent = await findAgent(db, caller.id);
        if (!agent) throw new ApiError(401, "invalid_token", "This token's Agent has been removed.");
        return { agent, workspace: caller.workspace, access: caller.access };
      },
    );
  };
}
