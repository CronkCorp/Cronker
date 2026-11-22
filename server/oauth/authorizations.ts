import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { requireOwnAgent } from "../agents/agents.js";
import type { Context } from "../context.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import { hashSecret, issueSecret } from "../identity/secrets.js";
import type { User } from "../identity/user.js";
import { mcpPath } from "../mcp/routes.js";
import { OAuthError, resolveClient, type OAuthClient } from "./clients.js";

/**
 * The authorization code flow with PKCE (OAuth 2.1). A client sends the browser to Cronk,
 * which keeps the request and shows its consent screen. There the User signs in and picks
 * one of their Agents; Cronk sends the browser back to the client with a one-time code,
 * which the client trades in for an access token acting as that Agent and a refresh token.
 */

/** How long the consent screen and then the code may take. */
const requestLifetimeMs = 10 * 60 * 1000;
/** How long an access token lasts; the client renews it with its refresh token. */
export const accessTokenLifetimeSeconds = 60 * 60;

/** The parameters of an authorization request, as the client sends them to `/oauth/authorize`. */
export interface AuthorizeQuery {
  client_id?: string;
  redirect_uri?: string;
  response_type?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  state?: string;
  resource?: string;
  scope?: string;
}

/** Where to send the browser next: the consent screen, or back to the client with an error. */
export type AuthorizeOutcome =
  | { kind: "consent"; requestId: string }
  | { kind: "error"; error: OAuthError; redirectUri: string };

/** The address of Cronk's MCP server: the one resource its tokens are for (RFC 8707). */
export const mcpResource = ({ config }: Context) => `${config.publicUrl.origin}${mcpPath}`;

/** Whether a `resource` parameter, if sent, names Cronk's MCP server, with or without a trailing slash. */
const forMcp = (context: Context, resource: string | undefined) =>
  resource === undefined || resource.replace(/\/$/, "") === mcpResource(context);

const later = (now: Date, ms: number) => new Date(now.getTime() + ms);

/** The redirect URI a request names, which must be one the client registered; with only one registered it may be left out. */
function redirectUriOf(client: OAuthClient, requested: string | undefined): string {
  if (requested === undefined && client.redirectUris.length === 1) return client.redirectUris[0]!;
  if (requested !== undefined && client.redirectUris.includes(requested)) return requested;
  throw new OAuthError("invalid_request", "That redirect URI isn't one the client registered.");
}

/** A URL sending the browser back to the client, with the response's parameters and Cronk as their issuer (RFC 9207). */
export function backToClient(context: Context, redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(name, value);
  url.searchParams.set("iss", context.config.publicUrl.origin);
  return url.toString();
}

/**
 * Checks a request for an authorization and keeps it for the consent screen. A request whose
 * client or redirect URI is wrong is refused outright, since the browser can't safely be sent
 * back; any other mistake goes back to the client as an error.
 */
export async function requestAuthorization(context: Context, query: AuthorizeQuery): Promise<AuthorizeOutcome> {
  if (!query.client_id) throw new OAuthError("invalid_request", "The request names no client, in `client_id`.");
  const client = await resolveClient(context, query.client_id);
  const redirectUri = redirectUriOf(client, query.redirect_uri);

  const fail = (error: string, description: string): AuthorizeOutcome => ({
    kind: "error",
    error: new OAuthError(error, description),
    redirectUri,
  });
  if (query.response_type !== "code") return fail("unsupported_response_type", "Cronk only issues authorization codes.");
  if (!query.code_challenge || query.code_challenge_method !== "S256") {
    return fail("invalid_request", "Cronk needs PKCE: a `code_challenge` with `code_challenge_method` S256.");
  }
  if (!forMcp(context, query.resource)) {
    return fail("invalid_target", `Cronk only issues tokens for its MCP server, ${mcpResource(context)}.`);
  }

  const now = context.clock.now();
  // Requests nobody finished are of no use to anyone; drop them while adding one.
  await context.db.query("delete from oauth_requests where expires_at <= $1", [now]);
  const { rows } = await context.db.query<{ id: string }>(
    `insert into oauth_requests (client_id, redirect_uri, code_challenge, state, created_at, expires_at)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [client.id, redirectUri, query.code_challenge, query.state ?? null, now, later(now, requestLifetimeMs)],
  );
  return { kind: "consent", requestId: rows[0]!.id };
}

export const AgentChoice = Type.Object({
  id: Type.String({ format: "uuid" }),
  name: Type.String(),
  workspace: Type.Object({ id: Type.String({ format: "uuid" }), name: Type.String() }),
});

export const AuthorizationRequest = Type.Object({
  client: Type.Object({
    id: Type.String(),
    name: Type.Union([Type.String(), Type.Null()], { description: "What the client calls itself; unchecked." }),
  }),
  redirectUri: Type.String({ description: "Where the browser goes back to once the User decides." }),
  agents: Type.Array(AgentChoice, {
    description: "The User's own Agents, in every Workspace they belong to, to act as.",
  }),
});
export type AuthorizationRequest = Static<typeof AuthorizationRequest>;

interface PendingRow {
  id: string;
  clientId: string;
  clientName: string | null;
  redirectUri: string;
  state: string | null;
}

/** A request still waiting on the consent screen, or a 404 refusal. */
async function pendingRequest({ db, clock }: Context, requestId: string): Promise<PendingRow> {
  const { rows } = isUuid(requestId)
    ? await db.query<PendingRow>(
        `select oauth_requests.id, oauth_clients.id as "clientId", oauth_clients.name as "clientName",
           oauth_requests.redirect_uri as "redirectUri", oauth_requests.state
         from oauth_requests join oauth_clients on oauth_clients.id = oauth_requests.client_id
         where oauth_requests.id = $1 and oauth_requests.expires_at > $2
           and oauth_requests.code_hash is null and oauth_requests.used_at is null`,
        [requestId, clock.now()],
      )
    : { rows: [] };
  if (!rows[0]) {
    throw new ApiError(404, "not_found", "That request to connect has expired or was already answered. Start connecting again from where you began.");
  }
  return rows[0];
}

/** What the consent screen shows: who asks, where the browser goes back to, and the User's Agents to pick from. */
export async function lookUpRequest(context: Context, user: User, requestId: string): Promise<AuthorizationRequest> {
  const request = await pendingRequest(context, requestId);
  const { rows: agents } = await context.db.query<Static<typeof AgentChoice>>(
    `select agents.id, agents.name, json_build_object('id', workspaces.id, 'name', workspaces.name) as workspace
     from agents
     join memberships on memberships.workspace_id = agents.workspace_id and memberships.user_id = agents.owner_id
     join workspaces on workspaces.id = agents.workspace_id
     where agents.owner_id = $1 and agents.removed_at is null
     order by lower(workspaces.name), workspaces.id, lower(agents.name), agents.id`,
    [user.id],
  );
  return {
    client: { id: request.clientId, name: request.clientName },
    redirectUri: request.redirectUri,
    agents,
  };
}

/** Approves a request as one of the User's own Agents: the browser goes back to the client with a one-time code. */
/** The approve route's body: the Agent of one's own the client acts as. */
export const RequestApproval = Type.Object({ agentId: Type.String() });
export type RequestApproval = Static<typeof RequestApproval>;

export async function approveRequest(context: Context, user: User, requestId: string, agentId: string): Promise<string> {
  const request = await pendingRequest(context, requestId);
  const agent = await requireOwnAgent(context.db, user.id, agentId);
  const code = issueSecret("oauth_code");
  const now = context.clock.now();
  const { rowCount } = await context.db.query(
    `update oauth_requests set agent_id = $2, code_hash = $3, expires_at = $4
     where id = $1 and code_hash is null and used_at is null`,
    [request.id, agent.id, hashSecret(code), later(context.clock.now(), requestLifetimeMs)],
  );
  if (rowCount === 0) throw new ApiError(404, "not_found", "That request to connect was already answered.");
  return backToClient(context, request.redirectUri, { code, state: request.state ?? undefined });
}

/** Denies a request: the browser goes back to the client, told access was denied. */
export async function denyRequest(context: Context, requestId: string): Promise<string> {
  const request = await pendingRequest(context, requestId);
  await context.db.query("update oauth_requests set used_at = $2 where id = $1", [request.id, context.clock.now()]);
  return backToClient(context, request.redirectUri, {
    error: "access_denied",
    error_description: "The User didn't connect an Agent.",
    state: request.state ?? undefined,
  });
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
}

/** The parameters of a request to the token endpoint, from its form body. */
export type TokenParams = Record<string, string | undefined>;

const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

/** Trades a code or a refresh token in for a new access token and refresh token (RFC 6749 §4.1.3, §6). */
export async function issueTokens(context: Context, params: TokenParams): Promise<TokenResponse> {
  if (!params.client_id) throw new OAuthError("invalid_client", "The request names no client, in `client_id`.", 401);
  if (!forMcp(context, params.resource)) {
    throw new OAuthError("invalid_target", `Cronk only issues tokens for its MCP server, ${mcpResource(context)}.`);
  }
  switch (params.grant_type) {
    case "authorization_code":
      return tradeCode(context, params.client_id, params);
    case "refresh_token":
      return refresh(context, params.client_id, params.refresh_token);
    default:
      throw new OAuthError("unsupported_grant_type", "Cronk takes `authorization_code` and `refresh_token` grants.");
  }
}

const invalidGrant = (description: string) => new OAuthError("invalid_grant", description);

/** Agents still in use whose Owner still belongs to their Workspace; only these may get tokens. */
const agentInUse = (agentId: string) => `exists (
  select 1 from agents join memberships on memberships.workspace_id = agents.workspace_id and memberships.user_id = agents.owner_id
  where agents.id = ${agentId} and agents.removed_at is null)`;

/** A PKCE code verifier: 43 to 128 unreserved characters (RFC 7636 §4.1). */
const verifierPattern = /^[A-Za-z0-9\-._~]{43,128}$/;

async function tradeCode(context: Context, clientId: string, params: TokenParams): Promise<TokenResponse> {
  if (!params.code || !params.code_verifier) throw new OAuthError("invalid_request", "Send the `code` and its `code_verifier`.");
  const { code, code_verifier: verifier } = params;
  if (!verifierPattern.test(verifier)) {
    throw new OAuthError("invalid_request", "A `code_verifier` is 43 to 128 letters, digits, `-`, `.`, `_` or `~`.");
  }
  const { db } = context;
  const now = context.clock.now();
  // The code is used up by any attempt to trade it in, so a wrong client or verifier can't try again.
  const { rows } = await db.query<{
    redirectUri: string;
    challenge: string;
    agentId: string;
    clientId: string;
    clientName: string | null;
  }>(
    `update oauth_requests set used_at = $2
     from oauth_clients
     where oauth_clients.id = oauth_requests.client_id and oauth_requests.code_hash = $1
       and oauth_requests.used_at is null and oauth_requests.expires_at > $2
     returning oauth_requests.redirect_uri as "redirectUri", oauth_requests.code_challenge as challenge,
       oauth_requests.agent_id as "agentId", oauth_requests.client_id as "clientId", oauth_clients.name as "clientName"`,
    [hashSecret(code), now],
  );
  const grant = rows[0];
  if (!grant || grant.clientId !== clientId) throw invalidGrant("That code was used already, has expired, or is another client's.");
  if (params.redirect_uri !== undefined && params.redirect_uri !== grant.redirectUri) {
    throw invalidGrant("The redirect URI isn't the one the code was issued for.");
  }
  if (s256(verifier) !== grant.challenge) throw invalidGrant("The code verifier doesn't match the code challenge.");

  const access = issueSecret("agent");
  const refreshToken = issueSecret("oauth_refresh");
  const { rowCount } = await db.query(
    `insert into agent_tokens (agent_id, name, access, token_hash, created_at, oauth_client_id, expires_at, refresh_hash)
     select $1, $2, 'full', $3, $4, $5, $6, $7 where ${agentInUse("$1")}`,
    [grant.agentId, grant.clientName ?? "OAuth client", hashSecret(access), now, clientId, expiry(now), hashSecret(refreshToken)],
  );
  if (rowCount === 0) throw invalidGrant("The Agent picked was removed, or its Owner left its Workspace.");
  return tokenResponse(access, refreshToken);
}

async function refresh(context: Context, clientId: string, refreshToken: string | undefined): Promise<TokenResponse> {
  if (!refreshToken) throw new OAuthError("invalid_request", "Send the `refresh_token`.");
  const now = context.clock.now();
  const access = issueSecret("agent");
  const next = issueSecret("oauth_refresh");
  // The refresh token is replaced along with the access token, so each one works once.
  const { rowCount } = await context.db.query(
    `update agent_tokens set token_hash = $3, refresh_hash = $4, expires_at = $5
     where refresh_hash = $1 and oauth_client_id = $2 and ${agentInUse("agent_tokens.agent_id")}`,
    [hashSecret(refreshToken), clientId, hashSecret(access), hashSecret(next), expiry(now)],
  );
  if (rowCount === 0) {
    throw invalidGrant("That refresh token was used already or revoked, or its Agent was removed. Connect again.");
  }
  return tokenResponse(access, next);
}

const expiry = (now: Date) => later(now, accessTokenLifetimeSeconds * 1000);

const tokenResponse = (access: string, refreshToken: string): TokenResponse => ({
  access_token: access,
  token_type: "Bearer",
  expires_in: accessTokenLifetimeSeconds,
  refresh_token: refreshToken,
});
