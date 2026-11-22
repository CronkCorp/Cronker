import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { ApiError, ErrorBody } from "../http/errors.js";
import { requireSignIn } from "../identity/sign-ins.js";
import { userViewer } from "../identity/viewers.js";
import { findWorkspace } from "../workspaces/workspaces.js";
import { liveEventTypes, runnerEventTypes, type LiveEvent, type RunnerEvent } from "./live.js";

/** Comments keep idle streams open through proxies that close quiet connections. */
const keepAliveMs = 25_000;

const list = (types: Record<string, string>) =>
  Object.entries(types)
    .map(([type, meaning]) => `- \`${type}\`: ${meaning}`)
    .join("\n");
const eventList = list(liveEventTypes);
const runnerEventList = list(runnerEventTypes);

export function liveRoutes(context: Context): FastifyPluginAsyncTypebox {
  const { db, live } = context;
  return async (app) => {
    // Open streams would otherwise keep the server from closing, and so would one subscribed later by a request
    // already under way.
    app.addHook("preClose", async () => live.close());

    app.get(
      "/api/workspaces/:workspaceId/events",
      {
        schema: {
          tags: ["Live updates"],
          summary: "The Workspace's event stream",
          description:
            "A `text/event-stream` of server-sent events, each telling of a change once it has committed. " +
            "The event's name is its type; its data is JSON naming the records that changed by id " +
            "(`projectId`, and `ticketId` and `commentId` where they apply), so clients fetch them again. " +
            "Events are sent only for changes in this Workspace, and only while the client belongs to it: " +
            "the stream ends when its sign-in ends or its User is removed from the Workspace. " +
            "Events about a Project go only to Users who can read it; `project.gained` and `project.lost` tell a " +
            "User when an Access change gives them a Project or takes one away. " +
            "Nothing is replayed after a reconnect, so a client fetches what it shows again then.\n\n" +
            eventList,
          params: Type.Object({ workspaceId: Type.String() }),
          produces: ["text/event-stream"],
          response: {
            200: Type.String({ description: "The event stream." }),
            401: ErrorBody,
            404: ErrorBody,
            503: ErrorBody,
          },
        },
      },
      async (request, reply) =>
        streamEvents(context, request, reply, async () => {
          const signIn = await requireSignIn(context, request);
          const workspace = await findWorkspace(db, userViewer(signIn.user.id), request.params.workspaceId);
          if (!workspace) throw new ApiError(404, "not_found", "No such Workspace.");
          return { ...signIn, workspaceId: workspace.id };
        }),
    );

    app.get(
      "/api/runners/events",
      {
        schema: {
          tags: ["Live updates"],
          summary: "Your Runners' event stream",
          description:
            "A `text/event-stream` of server-sent events about the signed-in User's own Runners, each telling of a " +
            "change once it has committed, as a Workspace's stream does. A Runner belongs to its User, not to a " +
            "Workspace, so its changes come here, whichever Workspace's Ticket its Run is on. The event's data is JSON " +
            "naming the Runner by `runnerId`, so clients fetch it again. The stream ends when its sign-in ends. " +
            "Nothing is replayed after a reconnect, so a client fetches what it shows again then.\n\n" +
            runnerEventList,
          produces: ["text/event-stream"],
          response: {
            200: Type.String({ description: "The event stream." }),
            401: ErrorBody,
            503: ErrorBody,
          },
        },
      },
      async (request, reply) =>
        streamEvents(context, request, reply, async () => ({ ...(await requireSignIn(context, request)), workspaceId: null })),
    );
  };
}

/**
 * Answers with an event stream for whom `allowed` lets in, checking it again once subscribed: a sign-out or removal
 * that committed between the check and subscribing found no stream to end.
 */
async function streamEvents(
  { clock, live }: Context,
  request: FastifyRequest,
  reply: FastifyReply,
  allowed: () => Promise<{ user: { id: string }; hash: string; expiresAt: Date; workspaceId: string | null }>,
): Promise<void> {
  const { user, hash, expiresAt, workspaceId } = await allowed();

  const raw = reply.raw;
  let started = false;
  let open = true;
  const write = (chunk: string) => {
    if (!started || !open) return;
    // An expired sign-in is ended by nothing else, so its stream ends on its next write.
    if (clock.now() >= expiresAt) return close();
    raw.write(chunk);
  };
  const close = () => {
    if (!open) return;
    open = false;
    clearInterval(keepAlive);
    unsubscribe();
    if (started) raw.end();
  };
  const unsubscribe = live.subscribe({
    workspaceId,
    userId: user.id,
    signIn: hash,
    send: ({ type, ...data }: LiveEvent | RunnerEvent) => write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`),
    end: close,
  });
  const keepAlive = setInterval(() => write(": keep-alive\n\n"), keepAliveMs);
  keepAlive.unref();

  try {
    await allowed();
  } catch (error) {
    close();
    throw error;
  }
  if (!open) {
    if (live.closed) throw new ApiError(503, "closing", "Cronk is shutting down; connect again shortly.");
    throw workspaceId === null ? new ApiError(401, "not_signed_in", "Sign in first.") : new ApiError(404, "not_found", "No such Workspace.");
  }

  reply.hijack();
  raw.on("close", close);
  raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  started = true;
  raw.write(": connected\n\n");
  if (request.socket.destroyed) close();
}
