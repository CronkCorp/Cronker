import type { FastifyInstance, FastifyRequest } from "fastify";
import { authenticateAgent, offersBearer, type AgentCaller } from "../agents/tokens.js";
import type { Context } from "../context.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import { findTicketRefByKey } from "../work/tickets.js";

/**
 * What a Run's Agent's calls do to the Run, whichever route they reach, the API's own or through MCP:
 * every call naming a running Run of the Agent, or its Ticket, keeps that Run from being lost, and
 * every call naming one of its Runs that a User stopped is refused.
 */
export function watchRunCalls(app: FastifyInstance, context: Context): void {
  app.addHook("preHandler", async (request) => {
    const agent = await agentOf(context, request);
    if (!agent) return;
    const params = (request.params ?? {}) as Record<string, string | undefined>;
    const runId = params.runId !== undefined && isUuid(params.runId) ? params.runId : null;
    let ticketId = params.ticketId !== undefined && isUuid(params.ticketId) ? params.ticketId : null;
    if (params.key !== undefined) ticketId = (await findTicketRefByKey(context.db, agent.workspace.id, params.key))?.id ?? null;
    if (runId) await refuseStoppedRun(context, agent, runId);
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
  return authenticateAgent(context, request).catch((error: unknown) => {
    if (error instanceof ApiError) return undefined;
    throw error;
  });
}

/** Refuses the Agent's call naming one of its own Runs that a User stopped, saying why. */
async function refuseStoppedRun(context: Context, agent: AgentCaller, runId: string): Promise<void> {
  const { rows } = await context.db.query<{ endReason: string; key: string }>(
    `select runs.end_reason as "endReason", projects.key || '-' || tickets.number as key
     from runs join tickets on tickets.id = runs.ticket_id join projects on projects.id = tickets.project_id
     where runs.id = $1 and runs.agent_id = $2 and runs.state = 'stopped'`,
    [runId, agent.id],
  );
  const stopped = rows[0];
  if (!stopped) return;
  throw new ApiError(409, "run_stopped", `${stopped.endReason.replace(/\.$/, "")}, which stopped this Run.`, {
    rule: "A User moving, undelegating or re-delegating a Ticket stops its running Run, and Cronk refuses the stopped Run's calls.",
    advice: `Stop working on ${stopped.key} and end your session. A User decides what happens to it next.`,
  });
}
