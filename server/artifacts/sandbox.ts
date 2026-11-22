import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { Context } from "../context.js";
import { ApiError } from "../http/errors.js";
import { sandboxPath, servedFile } from "./artifacts.js";

/**
 * Serves Artifacts' files from Cronk's own address, every response in the browser's sandbox: scripts run, but with
 * an opaque origin and without `allow-same-origin`, so a page can't read Cronk's cookies or call its API as the
 * signed-in User, in an iframe or opened directly (ADR 0004).
 */
/** The CDNs a page may load scripts, styles, images, media and fonts from; Google Fonts serves its fonts from gstatic. */
export const sandboxCdns = [
  "https://cdnjs.cloudflare.com",
  "https://cdn.jsdelivr.net",
  "https://unpkg.com",
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
].join(" ");

/**
 * On top of the sandbox, a page loads only its Version's own files, inline code and the CDNs, and fetches only its
 * own files, so a page can't send what it shows anywhere. `'self'` is the address the page was served from, Cronk's
 * own, not the page's opaque origin. `form-action` and `base-uri` don't fall back to `default-src`, so they are named.
 */
export const sandboxPolicy = [
  "sandbox allow-scripts",
  "default-src 'none'",
  `script-src 'self' 'unsafe-inline' ${sandboxCdns}`,
  `style-src 'self' 'unsafe-inline' ${sandboxCdns}`,
  `img-src 'self' data: blob: ${sandboxCdns}`,
  `media-src 'self' data: blob: ${sandboxCdns}`,
  `font-src 'self' data: blob: ${sandboxCdns}`,
  "connect-src 'self'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** Media types read as text, served as UTF-8. */
const textual = (mediaType: string) =>
  mediaType.startsWith("text/") || ["application/json", "application/xml", "image/svg+xml"].includes(mediaType);

export function sandboxRoutes(context: Context): FastifyPluginAsync {
  return async (app) => {
    // Every answer here, refusals included, is sandboxed and never framed or sniffed as anything else.
    app.addHook("onSend", async (_request, reply, payload) => {
      reply.header("content-security-policy", sandboxPolicy);
      reply.header("x-content-type-options", "nosniff");
      // The sandboxed page's origin is opaque, so its own `fetch` of a file is cross-origin: let any origin read
      // these files, without credentials. The key in the address is what guards a Version, as it already was.
      reply.header("access-control-allow-origin", "*");
      // The address is the key to the Version, so it is never sent on to the hosts a page loads from.
      reply.header("referrer-policy", "no-referrer");
      return payload;
    });

    const notFound = () => new ApiError(404, "not_found", "Nothing is here.");

    /** Serves the file at the path of the Version under the key; with no path, leads to the Version's page. */
    async function serve(key: string, path: string, reply: FastifyReply) {
      const found = await servedFile(context.db, key, path);
      if (!found) throw notFound();
      if ("page" in found) return reply.redirect(sandboxPath(key, found.page));
      const content = await context.attachments.get(found.blobId);
      if (!content) throw notFound();
      return reply
        .header("content-type", textual(found.mediaType) ? `${found.mediaType}; charset=utf-8` : found.mediaType)
        .header("content-length", found.size)
        // A Version never changes, so what is served under its key stays as it is.
        .header("cache-control", "private, max-age=31536000, immutable")
        .send(content);
    }

    app.get<{ Params: { key: string; "*": string } }>("/sandbox/:key/*", { schema: { hide: true } }, (request, reply) =>
      serve(request.params.key, request.params["*"], reply),
    );
    app.get<{ Params: { key: string } }>("/sandbox/:key", { schema: { hide: true } }, (request, reply) =>
      serve(request.params.key, "", reply),
    );
    // Anything else under the sandbox's path is answered here, sandboxed, rather than by the web client.
    for (const url of ["/sandbox", "/sandbox/"]) {
      app.get(url, { schema: { hide: true } }, async () => {
        throw notFound();
      });
    }
  };
}
