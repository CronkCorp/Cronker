import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { ApiError, ErrorBody } from "../http/errors.js";
import { requireUser } from "../identity/sign-ins.js";
import { inboxOf } from "../inbox/inbox.js";
import { requireMember } from "../workspaces/members.js";
import { findWorkspace } from "../workspaces/workspaces.js";

/** How often an idle stream sends a comment, so proxies along the way keep it open. */
const keepAliveMs = 25_000;

export function liveRoutes(context: Context): FastifyPluginAsyncTypebox {
  const { db, live } = context;
  return async (app) => {
    app.addHook("preClose", async () => live.endAll());

    app.get(
      "/api/workspaces/:workspaceId/events",
      {
        schema: {
          tags: ["Live"],
          summary: "A Workspace's event stream",
          description:
            "Server-sent events for the signed-in User in this Workspace, sent after the changes behind them commit. " +
            "`inbox` carries `{ count }`, the User's Inbox count: once when the stream opens, then whenever their Inbox " +
            "changes, even if its count stays the same. " +
            "The stream ends at the next change once the User has signed out or left the Workspace.",
          params: Type.Object({ workspaceId: Type.String() }),
          response: {
            200: Type.String({ description: "A `text/event-stream`." }),
            401: ErrorBody,
            404: ErrorBody,
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(context, request);
        const workspace = await requireMember(db, user.id, request.params.workspaceId);

        reply.hijack();
        const raw = reply.raw;
        raw.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        const send = (event: string, data: unknown) => raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

        let ended = false;
        let last: string | undefined;
        /** The stream lasts only while its sign-in lasts and its User belongs to the Workspace. */
        const stillAllowed = async () => {
          const signedIn = await requireUser(context, request).then(
            (current) => current.id === user.id,
            (error: unknown) => (error instanceof ApiError ? false : Promise.reject(error)),
          );
          return signedIn && (await findWorkspace(db, user.id, workspace.id)) !== undefined;
        };

        let refreshing = false;
        let again = false;
        // Changes may arrive faster than the Inbox is worked out; they are folded into one more
        // pass. `refreshing` is cleared in the same step as the last check of `again`, so no
        // change can arrive in between and be missed.
        const refresh = async () => {
          if (refreshing) {
            again = true;
            return;
          }
          refreshing = true;
          try {
            do {
              again = false;
              if (!(await stillAllowed())) return end();
              const inbox = await inboxOf(db, user.id, workspace.id);
              const seen = JSON.stringify(inbox);
              if (ended || seen === last) continue;
              last = seen;
              send("inbox", { count: inbox.count });
            } while (again && !ended);
          } catch (error) {
            request.log.error(error);
            end();
          } finally {
            refreshing = false;
          }
        };

        const keepAlive = setInterval(() => raw.write(":\n\n"), keepAliveMs);
        keepAlive.unref();
        const unwatch = live.watch(workspace.id, { changed: () => void refresh(), end: () => end() });
        function end() {
          if (ended) return;
          ended = true;
          clearInterval(keepAlive);
          unwatch();
          raw.end();
        }
        raw.on("close", end);
        void refresh();
      },
    );
  };
}
