import type { FastifyPluginAsync } from "fastify";
import type { Context } from "../context.js";
import { ApiError } from "../http/errors.js";
import { sandboxPath, servedFile } from "./artifacts.js";

/**
 * Serves Artifacts' files from Cronk's own address, every response in the browser's sandbox: scripts run, but with
 * an opaque origin and without `allow-same-origin`, so a page can't read Cronk's cookies or call its API as the
 * signed-in User, in an iframe or opened directly (ADR 0004).
 */
export const sandboxPolicy = "sandbox allow-scripts";

/** Media types read as text, served as UTF-8. */
const textual = (mediaType: string) =>
  mediaType.startsWith("text/") || ["application/json", "application/xml", "image/svg+xml"].includes(mediaType);

export function sandboxRoutes(context: Context): FastifyPluginAsync {
  return async (app) => {
    // Every answer here, refusals included, is sandboxed and never framed or sniffed as anything else.
    app.addHook("onSend", async (_request, reply, payload) => {
      reply.header("content-security-policy", sandboxPolicy);
      reply.header("x-content-type-options", "nosniff");
      // The address is the key to the Version, so it is never sent on to the hosts a page loads from.
      reply.header("referrer-policy", "no-referrer");
      return payload;
    });

    app.get<{ Params: { key: string; "*": string } }>(
      "/sandbox/:key/*",
      { schema: { hide: true } },
      async (request, reply) => {
        const { key, "*": path } = request.params;
        const found = await servedFile(context.db, key, path);
        const notFound = new ApiError(404, "not_found", "Nothing is here.");
        if (!found) throw notFound;
        if ("page" in found) return reply.redirect(sandboxPath(key, found.page));
        const content = await context.attachments.get(found.blobId);
        if (!content) throw notFound;
        return reply
          .header("content-type", textual(found.mediaType) ? `${found.mediaType}; charset=utf-8` : found.mediaType)
          .header("content-length", found.size)
          // A Version never changes, so what is served under its key stays as it is.
          .header("cache-control", "private, max-age=31536000, immutable")
          .send(content);
      },
    );
  };
}
