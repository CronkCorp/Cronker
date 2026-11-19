import type { Writable } from "node:stream";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import swagger from "@fastify/swagger";
import fastifyStatic from "@fastify/static";
import swaggerUi from "@fastify/swagger-ui";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { Context } from "./context.js";
import { agentOfRequest, agentOfToken, offersBearer } from "./agents/tokens.js";
import { ApiError, guidanceForAgent, sendError, type Guidance } from "./http/errors.js";
import { refuseOtherOrigins } from "./http/origin.js";
import { agentRoutes } from "./agents/routes.js";
import { refuseStoppedRunCalls } from "./runs/calls.js";
import { runRoutes } from "./runs/routes.js";
import { noteRunCall, type NamedInCall } from "./runs/runs.js";
import { mcpRoutes } from "./mcp/routes.js";
import { oauthRoutes } from "./oauth/routes.js";
import { githubRoutes } from "./github/routes.js";
import { identityRoutes } from "./identity/routes.js";
import { inboxRoutes } from "./inbox/routes.js";
import { knowledgeRoutes } from "./knowledge/routes.js";
import { liveRoutes } from "./live/routes.js";
import { ticketRoutes } from "./work/ticket-routes.js";
import { workRoutes } from "./work/routes.js";
import { workspaceRoutes } from "./workspaces/routes.js";

export interface AppOptions {
  logStream?: Writable;
}

/** The HTTP API, its OpenAPI documentation and the web client, as one Fastify app. */
export async function buildApp(context: Context, { logStream }: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logStream ? { stream: logStream } : true,
  }).withTypeProvider<TypeBoxTypeProvider>();

  // Every refusal an Agent meets names the rule and what it may do instead, including
  // refusals made before a route looked at the token, such as of a malformed request.
  const byAgent = async (request: FastifyRequest) => {
    const header = request.headers.authorization;
    return (
      agentOfRequest(request) !== undefined ||
      (offersBearer(header) && (await agentOfToken(context, header).then(() => true, () => false)))
    );
  };

  app.setErrorHandler(async (error, request, reply) => {
    const isAgent = await byAgent(request);
    const guide = (statusCode: number, guidance?: Guidance) =>
      guidance ?? (isAgent ? guidanceForAgent(statusCode) : undefined);
    if (error instanceof ApiError) {
      return sendError(
        reply,
        error.statusCode,
        error.code,
        error.message,
        guide(error.statusCode, error.guidance),
        error.details,
      );
    }
    const { validation, statusCode, message } = error as { validation?: unknown; statusCode?: number; message: string };
    if (validation) return sendError(reply, 400, "invalid_request", message, guide(400));
    if (statusCode && statusCode < 500) return sendError(reply, statusCode, "invalid_request", message, guide(statusCode));
    request.log.error(error);
    return sendError(reply, 500, "internal", "Something went wrong inside Cronk.");
  });

  refuseOtherOrigins(app, context.config.publicUrl);

  // An Agent's call naming one of its running Runs, or that Run's Ticket, shows the Run is still alive,
  // even a call refused before its route looked at the token, such as a malformed one.
  app.addHook("onSend", async (request, _reply, payload) => {
    const header = request.headers.authorization;
    const params = (request.params ?? {}) as Record<string, string | undefined>;
    const named: NamedInCall = { runId: params.runId, ticketId: params.ticketId, ticketKey: params.key };
    // Filing a Ticket names a Run in its body: the Run it is filed from, or a Sub-Ticket's parent, its Run's Ticket.
    if (request.method === "POST" && request.routeOptions.url === "/api/projects/:projectId/tickets") {
      const body = (request.body ?? {}) as Record<string, unknown>;
      if (typeof body.runId === "string") named.runId = body.runId;
      if (typeof body.parentId === "string") named.ticketId = body.parentId;
    }
    if (!named.runId && !named.ticketId && !named.ticketKey) return payload;
    try {
      const agent =
        agentOfRequest(request) ??
        (offersBearer(header) ? await agentOfToken(context, header).catch(() => undefined) : undefined);
      if (agent) await noteRunCall(context, agent, named);
    } catch (error) {
      // The call itself is answered as it was; only the Run's last call goes unrecorded.
      request.log.error(error);
    }
    return payload;
  });

  await app.register(swagger, {
    openapi: {
      info: { title: "Cronk API", version: "0.0.0" },
      servers: [{ url: context.config.publicUrl.origin }],
      components: {
        securitySchemes: {
          signIn: { type: "apiKey", in: "cookie", name: "cronk_sign_in", description: "A User's sign-in." },
          agentToken: {
            type: "http",
            scheme: "bearer",
            description:
              "An Agent's token. Agents may read their Workspace, comment on its Tickets and file Tickets; during their running Run on a Ticket they may also edit some of its fields, split it into Sub-Tickets, write Reports on it and finish the Run; they edit and add blocks from a Discovered Ticket they filed until a User takes it up; a read-only token may only read. Anything else is refused with `agent_not_allowed` or `read_only_token`, naming the `rule` and `advice`.",
          },
        },
      },
      security: [{ signIn: [] }, { agentToken: [] }],
    },
  });
  await app.register(swaggerUi, { routePrefix: "/api/docs" });
  app.get("/api/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  await app.register(cookie);
  refuseStoppedRunCalls(app, context);
  await app.register(identityRoutes(context));
  await app.register(githubRoutes(context));
  await app.register(workspaceRoutes(context));
  await app.register(workRoutes(context));
  await app.register(ticketRoutes(context));
  await app.register(knowledgeRoutes(context));
  await app.register(runRoutes(context));
  await app.register(inboxRoutes(context));
  await app.register(agentRoutes(context));
  await app.register(mcpRoutes(context, app));
  await app.register(oauthRoutes(context));
  await app.register(liveRoutes(context));

  const { webRoot } = context.config;
  if (webRoot) await app.register(fastifyStatic, { root: webRoot, wildcard: false });
  app.setNotFoundHandler(async (request, reply) => {
    // The web client routes its own paths, so any other page gets its index.
    if (webRoot && request.method === "GET" && !request.url.startsWith("/api/")) {
      return reply.sendFile("index.html");
    }
    return sendError(reply, 404, "not_found", "Nothing is here.", (await byAgent(request)) ? guidanceForAgent(404) : undefined);
  });

  return app;
}
