import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyReply } from "fastify";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { ErrorBody } from "../http/errors.js";
import { requireUser } from "../identity/sign-ins.js";
import { mcpPath, protectedResourcePath } from "../mcp/routes.js";
import {
  approveRequest,
  AuthorizationRequest,
  backToClient,
  denyRequest,
  issueTokens,
  lookUpRequest,
  requestAuthorization,
  type AuthorizeQuery,
  type TokenParams,
} from "./authorizations.js";
import { OAuthError, registerClient } from "./clients.js";

/**
 * Cronk as the OAuth 2.1 authorization server for its own MCP server, so an MCP client such as
 * a claude.ai connector connects as one of a User's Agents. Clients register dynamically
 * (RFC 7591) or name a Client ID Metadata Document; the consent screen picks the Agent.
 *
 * The endpoints a client calls speak OAuth's own error format, `{ error, error_description }`;
 * the ones the consent screen calls are part of Cronk's API.
 */

export const authorizePath = "/oauth/authorize";
export const tokenPath = "/oauth/token";
export const registerPath = "/oauth/register";
/** The web client's consent screen. */
export const consentPath = "/connect";

function sendOAuthError(reply: FastifyReply, error: OAuthError) {
  return reply
    .code(error.statusCode)
    .header("cache-control", "no-store")
    .send({ error: error.error, error_description: error.description });
}

export function oauthRoutes(context: Context): FastifyPluginAsyncTypebox {
  const origin = context.config.publicUrl.origin;
  return async (app) => {
    // The token endpoint takes a form, as OAuth has it.
    app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    });

    const protectedResource = async () => ({
      resource: `${origin}${mcpPath}`,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      resource_name: "Cronk",
    });
    // Clients look for the metadata at the path of the MCP server, or else at the root.
    app.get(protectedResourcePath, { schema: { hide: true } }, protectedResource);
    app.get("/.well-known/oauth-protected-resource", { schema: { hide: true } }, protectedResource);

    app.get("/.well-known/oauth-authorization-server", { schema: { hide: true } }, async () => ({
      issuer: origin,
      authorization_endpoint: `${origin}${authorizePath}`,
      token_endpoint: `${origin}${tokenPath}`,
      registration_endpoint: `${origin}${registerPath}`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    }));

    app.post(registerPath, { schema: { hide: true } }, async (request, reply) => {
      try {
        return reply.code(201).header("cache-control", "no-store").send(await registerClient(context, request.body));
      } catch (error) {
        if (error instanceof OAuthError) return sendOAuthError(reply, error);
        throw error;
      }
    });

    // For a browser to open. A request Cronk can't send back to the client goes to the consent screen with the error to show.
    app.get(authorizePath, { schema: { hide: true } }, async (request, reply) => {
      const query = request.query as AuthorizeQuery;
      try {
        const outcome = await requestAuthorization(context, query);
        if (outcome.kind === "consent") return reply.redirect(`${consentPath}?request=${outcome.requestId}`);
        return reply.redirect(
          backToClient(context, outcome.redirectUri!, {
            error: outcome.error.error,
            error_description: outcome.error.description,
            state: query.state,
          }),
        );
      } catch (error) {
        if (!(error instanceof OAuthError)) throw error;
        return reply.redirect(`${consentPath}?error=${encodeURIComponent(error.error)}`);
      }
    });

    app.post(tokenPath, { schema: { hide: true } }, async (request, reply) => {
      try {
        const body = (request.body ?? {}) as TokenParams;
        return reply.header("cache-control", "no-store").send(await issueTokens(context, body));
      } catch (error) {
        if (error instanceof OAuthError) return sendOAuthError(reply, error);
        throw error;
      }
    });

    const RequestParams = Type.Object({ requestId: Type.String() });
    const Redirect = Type.Object({ redirectTo: Type.String({ description: "Where to send the browser now." }) });

    app.get(
      "/api/oauth/requests/:requestId",
      {
        schema: {
          tags: ["Connecting"],
          summary: "A request to connect an app, for the consent screen",
          description:
            "An app such as a claude.ai connector asked to act as one of the signed-in User's Agents. Says which app asks, where the browser goes back to, and the User's own Agents to pick from.",
          params: RequestParams,
          response: { 200: AuthorizationRequest, 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => lookUpRequest(context, await requireUser(context, request), request.params.requestId),
    );

    app.post(
      "/api/oauth/requests/:requestId/approve",
      {
        schema: {
          tags: ["Connecting"],
          summary: "Connect the app as one of one's own Agents",
          description:
            "The app gets a one-time code to trade for tokens acting as the Agent, until the Agent is removed or the token is revoked from the Agent's tokens. Refused with `not_owner` for someone else's Agent.",
          params: RequestParams,
          body: Type.Object({ agentId: Type.String() }),
          response: { 200: Redirect, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        return { redirectTo: await approveRequest(context, user, request.params.requestId, request.body.agentId) };
      },
    );

    app.post(
      "/api/oauth/requests/:requestId/deny",
      {
        schema: {
          tags: ["Connecting"],
          summary: "Refuse to connect the app",
          params: RequestParams,
          response: { 200: Redirect, 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        await requireUser(context, request);
        return { redirectTo: await denyRequest(context, request.params.requestId) };
      },
    );
  };
}
