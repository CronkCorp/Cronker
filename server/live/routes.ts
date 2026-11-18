import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { ApiError, ErrorBody } from "../http/errors.js";
import { requireSignIn } from "../identity/sign-ins.js";
import { findWorkspace } from "../workspaces/workspaces.js";
import { liveEventTypes, type LiveEvent } from "./live.js";

/** Comments keep idle streams open through proxies that close quiet connections. */
const keepAliveMs = 25_000;

const eventList = Object.entries(liveEventTypes)
  .map(([type, meaning]) => `- \`${type}\`: ${meaning}`)
  .join("\n");

export function liveRoutes(context: Context): FastifyPluginAsyncTypebox {
  const { db, clock, live } = context;
  return async (app) => {
    // Open streams would otherwise keep the server from closing.
    app.addHook("preClose", async () => live.end(() => true));

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
            "Nothing is replayed after a reconnect, so a client fetches what it shows again then.\n\n" +
            eventList,
          params: Type.Object({ workspaceId: Type.String() }),
          produces: ["text/event-stream"],
          response: {
            200: Type.String({ description: "The event stream." }),
            401: ErrorBody,
            404: ErrorBody,
          },
        },
      },
      async (request, reply) => {
        const allowed = async () => {
          const signIn = await requireSignIn(context, request);
          const workspace = await findWorkspace(db, signIn.user.id, request.params.workspaceId);
          if (!workspace) throw new ApiError(404, "not_found", "No such Workspace.");
          return { ...signIn, workspace };
        };
        const { user, hash, expiresAt, workspace } = await allowed();

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
          workspaceId: workspace.id,
          userId: user.id,
          signIn: hash,
          send: ({ type, ...data }: LiveEvent) => write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`),
          end: close,
        });
        const keepAlive = setInterval(() => write(": keep-alive\n\n"), keepAliveMs);
        keepAlive.unref();

        // A sign-out or removal that committed between the check and subscribing found no stream to end.
        try {
          await allowed();
        } catch (error) {
          close();
          throw error;
        }
        if (!open) throw new ApiError(404, "not_found", "No such Workspace.");

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
      },
    );
  };
}
