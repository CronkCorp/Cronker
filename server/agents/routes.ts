import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { ErrorBody } from "../http/errors.js";
import { requireUser } from "../identity/sign-ins.js";
import { requireMember } from "../workspaces/members.js";
import { Agent, AgentName, agentsOf, createAgent, removeAgent, renameAgent, requireOwnAgent } from "./agents.js";

export function agentRoutes(context: Context): FastifyPluginAsyncTypebox {
  const { db, clock } = context;
  return async (app) => {
    app.get(
      "/api/workspaces/:workspaceId/agents",
      {
        schema: {
          tags: ["Agents"],
          summary: "The Workspace's Agents",
          description: "Every member's Agents, by name.",
          params: Type.Object({ workspaceId: Type.String() }),
          response: { 200: Type.Array(Agent), 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        const workspace = await requireMember(db, user.id, request.params.workspaceId);
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
          summary: "Rename one's own Agent",
          description: "Only the Agent's Owner can rename it (`not_owner` otherwise).",
          params: AgentParams,
          body: Type.Object({ name: AgentName }),
          response: { 200: Agent, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        const agent = await requireOwnAgent(db, user.id, request.params.agentId);
        return renameAgent(db, agent, request.body.name);
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
  };
}
