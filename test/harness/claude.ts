import { createServer, type IncomingMessage, type Server } from "node:http";

/**
 * A stand-in for the claude.ai scheduled-task fire endpoint the subscription Runner calls:
 * `POST /v1/claude_code/routines/{triggerId}/fire` with the trigger's token as a bearer token
 * and `{ "text": … }`, answering with the new session's id and URL. The real service is never called.
 *
 * Every trigger it is given with `trigger(id, token)` fires; any other id answers 404, and a
 * wrong token 401. A test stages a rate limit with `rateLimitNext(retryAfter)`.
 */

export interface Fire {
  triggerId: string;
  /** The bearer token the fire was sent with. */
  token: string;
  headers: IncomingMessage["headers"];
  /** The request body, as parsed JSON. */
  body: Record<string, unknown>;
}

export interface StandInClaude {
  /** The API address, like `https://api.anthropic.com`. */
  apiUrl: string;
  /** Every fire asked of it, answered or not, in order. */
  fires: Fire[];
  /** Adds a trigger the endpoint knows, with its token. */
  trigger(triggerId: string, token: string): void;
  /** Answers the next fire with 429, sending `Retry-After` as given (seconds or an HTTP date) unless undefined. */
  rateLimitNext(retryAfter: string | undefined): void;
  stop(): Promise<void>;
}

export async function startStandInClaude(): Promise<StandInClaude> {
  const triggers = new Map<string, string>();
  const rateLimits: (string | undefined)[] = [];
  const fires: Fire[] = [];
  let sessions = 0;

  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify(body));
    };
    const match = /^\/v1\/claude_code\/routines\/([^/]+)\/fire$/.exec(request.url ?? "");
    if (request.method !== "POST" || !match) return json(404, { type: "error", error: { type: "not_found_error" } });
    const triggerId = decodeURIComponent(match[1]!);
    const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "";
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    } catch {
      return json(400, { type: "error", error: { type: "invalid_request_error", message: "Body is not JSON." } });
    }
    fires.push({ triggerId, token, headers: request.headers, body });

    if (rateLimits.length > 0) {
      const retryAfter = rateLimits.shift();
      return json(
        429,
        { type: "error", error: { type: "rate_limit_error", message: "Rate limited." } },
        retryAfter === undefined ? {} : { "retry-after": retryAfter },
      );
    }
    if (!triggers.has(triggerId)) {
      return json(404, { type: "error", error: { type: "not_found_error", message: "Routine not found." } });
    }
    if (triggers.get(triggerId) !== token) {
      return json(401, { type: "error", error: { type: "authentication_error", message: "Invalid bearer token." } });
    }
    sessions += 1;
    const sessionId = `cse_0${sessions}STANDIN`;
    return json(200, {
      type: "routine_fire",
      claude_code_session_id: sessionId,
      claude_code_session_url: `https://claude.ai/code/${sessionId}`,
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("no port");

  return {
    apiUrl: `http://127.0.0.1:${address.port}`,
    fires,
    trigger(triggerId, token) {
      triggers.set(triggerId, token);
    },
    rateLimitNext(retryAfter) {
      rateLimits.push(retryAfter);
    },
    stop: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
