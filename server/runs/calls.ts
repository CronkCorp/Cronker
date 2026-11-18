import type { FastifyInstance, FastifyRequest } from "fastify";
import { authenticateAgent, offersBearer, type AgentCaller } from "../agents/tokens.js";
import type { Context } from "../context.js";
import { isUuid } from "../http/ids.js";
import { findTicketRefByKey } from "../work/tickets.js";

/**
 * What a Run's Agent's calls do to the Run, whichever route they reach, the API's own or through MCP:
 * every call naming a running Run of the Agent, or its Ticket, keeps that Run from being lost.
 */
export function watchRunCalls(app: FastifyInstance, context: Context): void {
  app.addHook("preHandler", async (request) => {
    const agent = await agentOf(context, request);
    if (!agent) return;
    const params = (request.params ?? {}) as Record<string, string | undefined>;
    const runId = params.runId !== undefined && isUuid(params.runId) ? params.runId : null;
    let ticketId = params.ticketId !== undefined && isUuid(params.ticketId) ? params.ticketId : null;
    if (params.key !== undefined) ticketId = (await findTicketRefByKey(context.db, agent.workspace.id, params.key))?.id ?? null;
    if (!runId && !ticketId) return;
    await context.db.query(
      `update runs set last_call_at = $1
       where state = 'running' and agent_id = $2 and (id = $3 or ticket_id = $4)`,
      [context.clock.now(), agent.id, runId, ticketId],
    );
  });
}

/** The Agent making the request, if it is one with a token Cronk accepts; the route itself refuses any other. */
async function agentOf(context: Context, request: FastifyRequest): Promise<AgentCaller | undefined> {
  if (!offersBearer(request.headers.authorization)) return undefined;
  return authenticateAgent(context, request).catch(() => undefined);
}
