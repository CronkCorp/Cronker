import type { FastifyInstance, FastifyRequest } from "fastify";
import { authenticateAgent, offersBearer, type AgentCaller } from "../agents/tokens.js";
import type { Context } from "../context.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";

/**
 * Refuses every call an Agent makes naming one of its Runs that a User stopped, whichever route it reaches,
 * the API's own or through MCP. (Calls naming a running Run or its Ticket are noted by `noteRunCall`.)
 */
export function refuseStoppedRunCalls(app: FastifyInstance, context: Context): void {
  app.addHook("preHandler", async (request) => {
    const params = (request.params ?? {}) as Record<string, string | undefined>;
    if (params.runId === undefined || !isUuid(params.runId)) return;
    const agent = await agentOf(context, request);
    if (agent) await refuseStoppedRun(context, agent, params.runId);
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
