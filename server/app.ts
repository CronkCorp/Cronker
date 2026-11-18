import type { Writable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import swagger from "@fastify/swagger";
import fastifyStatic from "@fastify/static";
import swaggerUi from "@fastify/swagger-ui";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { Context } from "./context.js";
import { ApiError, sendError } from "./http/errors.js";
import { refuseOtherOrigins } from "./http/origin.js";
import { identityRoutes } from "./identity/routes.js";
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

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) return sendError(reply, error.statusCode, error.code, error.message);
    const { validation, statusCode, message } = error as { validation?: unknown; statusCode?: number; message: string };
    if (validation) return sendError(reply, 400, "invalid_request", message);
    if (statusCode && statusCode < 500) return sendError(reply, statusCode, "invalid_request", message);
    request.log.error(error);
    return sendError(reply, 500, "internal", "Something went wrong inside Cronk.");
  });

  refuseOtherOrigins(app, context.config.publicUrl);

  await app.register(swagger, {
    openapi: {
      info: { title: "Cronk API", version: "0.0.0" },
      servers: [{ url: context.config.publicUrl.origin }],
    },
  });
  await app.register(swaggerUi, { routePrefix: "/api/docs" });
  app.get("/api/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  await app.register(cookie);
  await app.register(identityRoutes(context));
  await app.register(workspaceRoutes(context));
  await app.register(workRoutes(context));
  await app.register(ticketRoutes(context));

  const { webRoot } = context.config;
  if (webRoot) await app.register(fastifyStatic, { root: webRoot, wildcard: false });
  app.setNotFoundHandler((request, reply) => {
    // The web client routes its own paths, so any other page gets its index.
    if (webRoot && request.method === "GET" && !request.url.startsWith("/api/")) {
      return reply.sendFile("index.html");
    }
    return sendError(reply, 404, "not_found", "Nothing is here.");
  });

  return app;
}
