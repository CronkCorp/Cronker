import type { FastifyRequest } from "fastify";
import { authenticateAgent, type AgentCaller } from "../agents/tokens.js";
import type { Context } from "../context.js";
import { requireUser } from "./sign-ins.js";
import type { User } from "./user.js";

/** Whoever makes a request: a signed-in User, or an Agent with one of its tokens. */
export type Caller = ({ kind: "user" } & User) | AgentCaller;
export type { AgentCaller };

/** The User or Agent making the request, or a 401 refusal. For what Agents may do as well as Users. */
export async function requireCaller(context: Context, request: FastifyRequest): Promise<Caller> {
  const agent = await authenticateAgent(context, request);
  if (agent) return agent;
  return { kind: "user", ...(await requireUser(context, request)) };
}
