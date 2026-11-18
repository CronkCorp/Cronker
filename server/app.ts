import type { Writable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { Context } from "./context.js";
import { ApiError } from "./http/errors.js";
import { identityRoutes } from "./identity/routes.js";
import { workspaceRoutes } from "./workspaces/routes.js";

export interface AppOptions {
  logStream?: Writable;
}

/** The HTTP API, its OpenAPI documentation and the web client, as one Fastify app. */
export async function buildApp(context: Context, { logStream }: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logStream ? { stream: logStream } : true,
    trustProxy: true,
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    const fastifyError = error as { validation?: unknown; statusCode?: number; message: string };
    if (fastifyError.validation) {
      return reply.code(400).send({ error: { code: "invalid_request", message: fastifyError.message } });
    }
    if (fastifyError.statusCode && fastifyError.statusCode < 500) {
      return reply.code(fastifyError.statusCode).send({ error: { code: "invalid_request", message: fastifyError.message } });
    }
    request.log.error(error);
    return reply.code(500).send({ error: { code: "internal", message: "Something went wrong inside Cronk." } });
  });

  await app.register(swagger, {
    openapi: {
      info: { title: "Cronk API", version: "0.0.0" },
      servers: [{ url: context.config.publicUrl.origin }],
    },
  });
  await app.register(swaggerUi, { routePrefix: "/api/docs" });

  await app.register(cookie);
  await app.register(identityRoutes(context));
  await app.register(workspaceRoutes(context));

  return app;
}
