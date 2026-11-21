import { createHmac, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";

/**
 * A stand-in for the Claude API's Managed Agents endpoints the `managed_agents` Runner calls: agents, environments,
 * vaults and their credentials, sessions with their events, resources, interrupts and archives. The real service is
 * never called.
 *
 * Only API keys it is given with `apiKey(key)` are accepted (`x-api-key`); any other answers 401. As the real
 * service does, a vault holds one active credential per MCP server URL (a second answers 409), and a session made
 * with `initial_events` starts running. Each of a session's `github_repository` resources gets an id, and its
 * `authorization_token` can be replaced on the running session, as the real service allows. A test drives a session with `idle(id, stopReason)` and `terminate(id)`, and
 * stages a rate limit with `rateLimitNext(retryAfter)` or another failure with `failNext(method, path, status)`.
 *
 * It also sends webhook deliveries as Anthropic does from an endpoint registered in the Console: `deliver(url, …)`
 * posts a thin event about a session, signed with the endpoint's `whsec_` secret (`webhookSecret()` makes one).
 */

/** A `github_repository` resource of a session. */
export interface StandInResource {
  id: string;
  type: string;
  url: string;
  /** The token the session holds for it now: the create request's, or the latest update's. */
  authorizationToken: string;
}

export interface StandInSession {
  id: string;
  resources: StandInResource[];
  /** The create request's body, as sent. */
  body: Record<string, unknown>;
  status: "idle" | "running" | "rescheduling" | "terminated";
  /** Every event of the session, sent or emitted, oldest first. */
  events: Record<string, unknown>[];
  archived: boolean;
  deleted: boolean;
}

export interface StandInCredential {
  id: string;
  body: Record<string, unknown>;
}

export interface StandInVault {
  id: string;
  body: Record<string, unknown>;
  credentials: StandInCredential[];
  deleted: boolean;
}

export interface ManagedAgentsCall {
  method: string;
  path: string;
  apiKey: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown> | null;
}

export interface StandInManagedAgents {
  /** The API address, like `https://api.anthropic.com`. */
  apiUrl: string;
  /** Every request it answered, in order. */
  calls: ManagedAgentsCall[];
  /** Agents created, each create request's body by its id. */
  agents: { id: string; apiKey: string; body: Record<string, unknown>; archived: boolean }[];
  environments: { id: string; apiKey: string; body: Record<string, unknown> }[];
  vaults: StandInVault[];
  sessions: StandInSession[];
  /** Adds an API key the service accepts. */
  apiKey(key: string): void;
  /** Answers the next request with 429, sending `Retry-After` as given (seconds or an HTTP date) unless undefined. */
  rateLimitNext(retryAfter: string | undefined): void;
  /** Answers the next request to this method and path (such as `POST /v1/environments`) with this status, as an outage would. */
  failNext(method: string, path: string, status: number): void;
  /** The session with this id. */
  session(id: string): StandInSession;
  /** The session went idle, recording a `session.status_idle` event with the stop reason, such as `end_turn`. */
  idle(id: string, stopReason: string): void;
  /** The session terminated, recording a `session.status_terminated` event. */
  terminate(id: string): void;
  /** A new signing secret, as the Console shows once for a webhook endpoint: `whsec_` and 32 random bytes in base64. */
  webhookSecret(): string;
  /**
   * Sends a webhook delivery to `url` as Anthropic does: a thin event of this type about the session, with the
   * `webhook-id`, `webhook-timestamp` and `webhook-signature` headers, signed with `secret` (another secret signs it
   * wrongly). `id` is the event's id, the same on every retry of it; `at` the time of this attempt. Returns Cronk's answer.
   */
  deliver(url: string, delivery: WebhookDelivery): Promise<Response>;
  stop(): Promise<void>;
}

export interface WebhookDelivery {
  secret: string;
  type: string;
  sessionId: string;
  at: Date;
  id?: string;
}

/** Signs a webhook delivery as Standard Webhooks, which Anthropic follows, says: `v1,` and the base64 HMAC-SHA256 of `id.timestamp.body`. */
function signature(secret: string, id: string, timestamp: string, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

export async function startStandInManagedAgents(): Promise<StandInManagedAgents> {
  const apiKeys = new Set<string>();
  const rateLimits: (string | undefined)[] = [];
  const failures: { method: string; path: string; status: number }[] = [];
  const calls: ManagedAgentsCall[] = [];
  const agents: StandInManagedAgents["agents"] = [];
  const environments: StandInManagedAgents["environments"] = [];
  const vaults: StandInVault[] = [];
  const sessions: StandInSession[] = [];
  let ids = 0;
  const nextId = (prefix: string) => `${prefix}_0${++ids}STANDIN`;
  const emit = (session: StandInSession, event: Record<string, unknown>) => {
    session.events.push({ id: nextId("sevt"), processed_at: new Date().toISOString(), ...event });
  };
  const presentSession = (s: StandInSession) => ({
    type: "session",
    id: s.id,
    status: s.status,
    archived_at: s.archived ? new Date().toISOString() : null,
    environment_id: s.body.environment_id,
    vault_ids: s.body.vault_ids ?? [],
    // The token is never echoed, as Anthropic never echoes it.
    resources: s.resources.map((r) => ({ type: r.type, id: r.id, url: r.url })),
  });

  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify(body));
    };
    const error = (status: number, type: string, message: string, headers: Record<string, string> = {}) =>
      json(status, { type: "error", error: { type, message } }, headers);
    const url = new URL(request.url ?? "/", "http://stand-in");
    const method = request.method ?? "GET";
    const apiKey = String(request.headers["x-api-key"] ?? "");
    let body: Record<string, unknown> | null = null;
    if (chunks.length > 0) {
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      } catch {
        return error(400, "invalid_request_error", "Body is not JSON.");
      }
    }
    calls.push({ method, path: url.pathname, apiKey, headers: request.headers, body });

    if (rateLimits.length > 0) {
      const retryAfter = rateLimits.shift();
      return error(429, "rate_limit_error", "Rate limited.", retryAfter === undefined ? {} : { "retry-after": retryAfter });
    }
    const failing = failures.findIndex((f) => f.method === method && f.path === url.pathname);
    if (failing >= 0) {
      const [failure] = failures.splice(failing, 1);
      return error(failure!.status, "api_error", "Something went wrong.");
    }
    if (!apiKeys.has(apiKey)) return error(401, "authentication_error", "invalid x-api-key");
    if (request.headers["anthropic-beta"] !== "managed-agents-2026-04-01") {
      return error(400, "invalid_request_error", "This endpoint needs the managed-agents-2026-04-01 beta.");
    }
    const path = url.pathname;
    const route = (pattern: RegExp, expected: string) => (method === expected ? pattern.exec(path) : null);
    let match: RegExpExecArray | null;

    if (route(/^\/v1\/agents$/, "POST")) {
      const agent = { id: nextId("agent"), apiKey, body: body ?? {}, archived: false };
      agents.push(agent);
      return json(200, { type: "agent", id: agent.id, version: 1, ...agent.body });
    }
    if ((match = route(/^\/v1\/agents\/([^/]+)\/archive$/, "POST"))) {
      const agent = agents.find((a) => a.id === match![1]);
      if (!agent) return error(404, "not_found_error", "No such agent.");
      agent.archived = true;
      return json(200, { type: "agent", id: agent.id, archived_at: new Date().toISOString() });
    }
    if (route(/^\/v1\/environments$/, "POST")) {
      const environment = { id: nextId("env"), apiKey, body: body ?? {} };
      environments.push(environment);
      return json(200, { type: "environment", id: environment.id, ...environment.body });
    }
    if (route(/^\/v1\/vaults$/, "POST")) {
      const vault: StandInVault = { id: nextId("vlt"), body: body ?? {}, credentials: [], deleted: false };
      vaults.push(vault);
      return json(200, { type: "vault", id: vault.id, ...vault.body });
    }
    const vaultOf = (id: string) => vaults.find((v) => v.id === id && !v.deleted);
    if ((match = route(/^\/v1\/vaults\/([^/]+)\/credentials$/, "POST"))) {
      const vault = vaultOf(match[1]!);
      if (!vault) return error(404, "not_found_error", "No such vault.");
      const auth = (body?.auth ?? {}) as Record<string, unknown>;
      if (vault.credentials.some((c) => (c.body.auth as Record<string, unknown>).mcp_server_url === auth.mcp_server_url)) {
        return error(409, "invalid_request_error", "A credential already exists for this MCP server URL");
      }
      const credential = { id: nextId("vcrd"), body: body ?? {} };
      vault.credentials.push(credential);
      return json(200, { type: "vault_credential", id: credential.id, display_name: body?.display_name });
    }
    if ((match = route(/^\/v1\/vaults\/([^/]+)\/credentials\/([^/]+)$/, "DELETE"))) {
      const vault = vaultOf(match[1]!);
      const index = vault?.credentials.findIndex((c) => c.id === match![2]) ?? -1;
      if (!vault || index < 0) return error(404, "not_found_error", "No such credential.");
      vault.credentials.splice(index, 1);
      return json(200, { type: "vault_credential_deleted", id: match[2] });
    }
    if ((match = route(/^\/v1\/vaults\/([^/]+)$/, "DELETE"))) {
      const vault = vaultOf(match[1]!);
      if (!vault) return error(404, "not_found_error", "No such vault.");
      vault.deleted = true;
      vault.credentials = [];
      return json(200, { type: "vault_deleted", id: vault.id });
    }
    if (route(/^\/v1\/sessions$/, "POST")) {
      const vaultIds = (body?.vault_ids ?? []) as string[];
      if (vaultIds.some((id) => !vaultOf(id))) return error(404, "not_found_error", "No such vault.");
      const agent = body?.agent as Record<string, unknown> | undefined;
      if (!agents.some((a) => a.id === agent?.id)) return error(404, "not_found_error", "No such agent.");
      if (!environments.some((e) => e.id === body?.environment_id)) return error(404, "not_found_error", "No such environment.");
      const initial = (body?.initial_events ?? []) as Record<string, unknown>[];
      const resources = (body?.resources ?? []) as Record<string, unknown>[];
      if (resources.some((r) => r.type !== "github_repository" || typeof r.url !== "string" || typeof r.authorization_token !== "string")) {
        return error(400, "invalid_request_error", "A github_repository resource needs a url and an authorization_token.");
      }
      const session: StandInSession = {
        id: nextId("sesn"),
        resources: resources.map((r) => ({
          id: nextId("sesrsc"),
          type: "github_repository",
          url: r.url as string,
          authorizationToken: r.authorization_token as string,
        })),
        body: body ?? {},
        status: initial.length > 0 ? "running" : "idle",
        events: [],
        archived: false,
        deleted: false,
      };
      for (const event of initial) emit(session, event);
      sessions.push(session);
      return json(200, presentSession(session));
    }
    const sessionOf = (id: string) => sessions.find((s) => s.id === id && !s.deleted);
    if ((match = route(/^\/v1\/sessions\/([^/]+)$/, "GET"))) {
      const session = sessionOf(match[1]!);
      return session ? json(200, presentSession(session)) : error(404, "not_found_error", "No such session.");
    }
    if ((match = route(/^\/v1\/sessions\/([^/]+)\/events$/, "GET"))) {
      const session = sessionOf(match[1]!);
      if (!session) return error(404, "not_found_error", "No such session.");
      const ordered = url.searchParams.get("order") === "desc" ? [...session.events].reverse() : session.events;
      const limit = Number(url.searchParams.get("limit") ?? "1000");
      const from = Number(url.searchParams.get("page") ?? "0");
      const page = ordered.slice(from, from + limit);
      const next = from + limit < ordered.length ? String(from + limit) : null;
      return json(200, { data: page, next_page: next });
    }
    if ((match = route(/^\/v1\/sessions\/([^/]+)\/events$/, "POST"))) {
      const session = sessionOf(match[1]!);
      if (!session) return error(404, "not_found_error", "No such session.");
      if (session.archived || session.status === "terminated") return error(400, "invalid_request_error", "The session can't take events.");
      for (const event of (body?.events ?? []) as Record<string, unknown>[]) {
        emit(session, event);
        if (event.type === "user.interrupt" && session.status === "running") {
          session.status = "idle";
          emit(session, { type: "session.status_idle", stop_reason: { type: "end_turn" } });
        }
      }
      return json(200, { data: [] });
    }
    if ((match = route(/^\/v1\/sessions\/([^/]+)\/resources\/([^/]+)$/, "POST"))) {
      const session = sessionOf(match[1]!);
      const resource = session?.resources.find((r) => r.id === match![2]);
      if (!session || !resource) return error(404, "not_found_error", "No such resource.");
      if (typeof body?.authorization_token !== "string") return error(400, "invalid_request_error", "authorization_token is required.");
      resource.authorizationToken = body.authorization_token;
      return json(200, { type: resource.type, id: resource.id, url: resource.url });
    }
    if ((match = route(/^\/v1\/sessions\/([^/]+)\/archive$/, "POST"))) {
      const session = sessionOf(match[1]!);
      if (!session) return error(404, "not_found_error", "No such session.");
      if (session.status === "running") return error(400, "invalid_request_error", "A running session can't be archived.");
      session.archived = true;
      return json(200, presentSession(session));
    }
    if ((match = route(/^\/v1\/sessions\/([^/]+)$/, "DELETE"))) {
      const session = sessionOf(match[1]!);
      if (!session) return error(404, "not_found_error", "No such session.");
      session.deleted = true;
      return json(200, { type: "session_deleted", id: session.id });
    }
    return error(404, "not_found_error", `No route for ${method} ${path}.`);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("no port");
  const session = (id: string) => {
    const found = sessions.find((s) => s.id === id);
    if (!found) throw new Error(`the stand-in Managed Agents API has no session ${id}`);
    return found;
  };

  return {
    apiUrl: `http://127.0.0.1:${address.port}`,
    calls,
    agents,
    environments,
    vaults,
    sessions,
    apiKey(key) {
      apiKeys.add(key);
    },
    rateLimitNext(retryAfter) {
      rateLimits.push(retryAfter);
    },
    failNext(method, path, status) {
      failures.push({ method, path, status });
    },
    session,
    idle(id, stopReason) {
      const s = session(id);
      s.status = "idle";
      emit(s, { type: "session.status_idle", stop_reason: { type: stopReason } });
    },
    terminate(id) {
      const s = session(id);
      s.status = "terminated";
      emit(s, { type: "session.status_terminated" });
    },
    webhookSecret: () => `whsec_${randomBytes(32).toString("base64")}`,
    deliver(url, { secret, type, sessionId, at, id = nextId("whe") }) {
      const body = JSON.stringify({
        type: "event",
        id,
        created_at: at.toISOString(),
        data: { type, id: sessionId, organization_id: "org-standin", workspace_id: "wrkspc-standin" },
      });
      const timestamp = String(Math.floor(at.getTime() / 1000));
      return fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "webhook-id": id,
          "webhook-timestamp": timestamp,
          "webhook-signature": signature(secret, id, timestamp, body),
        },
        body,
      });
    },
    stop: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
