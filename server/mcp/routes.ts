import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { agentOfToken, offersBearer } from "../agents/tokens.js";
import type { Context } from "../context.js";
import { ApiError, sendError } from "../http/errors.js";
import { buildMcpServer, type Api } from "./tools.js";

/** Where Cronk's MCP server answers, on its public address. */
export const mcpPath = "/mcp";

/**
 * Cronk's MCP server over streamable HTTP, without sessions: every request carries an
 * Agent's bearer token and is checked afresh, so a revoked token is refused at once.
 * Its tools call the HTTP API as that Agent, so the API's rules are the only rules.
 */
export function mcpRoutes(context: Context, api: FastifyInstance): FastifyPluginAsync {
  return async (app) => {
    app.post(mcpPath, { schema: { hide: true } }, async (request, reply) => {
      const authorization = request.headers.authorization;
      try {
        if (!offersBearer(authorization)) {
          throw new ApiError(401, "invalid_token", "Cronk's MCP server needs an Agent token.", {
            rule: "MCP requests carry an Agent's token as `Authorization: Bearer …`.",
            advice: "Ask a User to issue a token for one of their Agents, and send it as a bearer token.",
          });
        }
        await agentOfToken(context, authorization);
      } catch (error) {
        if (!(error instanceof ApiError) || error.statusCode !== 401) throw error;
        reply.header("www-authenticate", `Bearer realm="Cronk", error="invalid_token"`);
        return sendError(reply, 401, error.code, error.message, error.guidance);
      }

      const asAgent: Api = async (method, path, body) => {
        const response = await api.inject({
          method: method as "GET" | "POST",
          url: path,
          headers: { authorization },
          ...(body === undefined ? {} : { payload: body as object }),
        });
        return { status: response.statusCode, json: response.body ? response.json() : null };
      };
      const server = buildMcpServer(asAgent);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      reply.raw.on("close", () => {
        void transport.close();
        void server.close();
      });
      reply.hijack();
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    });

    // Without sessions there is no stream to open or session to end.
    for (const method of ["GET", "DELETE"] as const) {
      app.route({
        method,
        url: mcpPath,
        schema: { hide: true },
        handler: async (_request, reply) =>
          sendError(reply.header("allow", "POST"), 405, "method_not_allowed", "Cronk's MCP server takes POST requests only.", {
            rule: "Cronk's MCP server keeps no sessions, so it has no stream to open or session to end.",
            advice: "Send each MCP request as a POST with your Agent's token.",
          }),
      });
    }
  };
}
