import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { ApiError, ErrorBody } from "../http/errors.js";
import { requireCaller } from "../identity/callers.js";
import {
  addAttachment,
  Attachment,
  attachmentContent,
  attachmentsOn,
  attachmentTooLarge,
  mediaTypeOf,
  removeAttachment,
  type OwnerKind,
} from "./attachments.js";

const tags = ["Attachments"];

/** Media types served as themselves: pictures a browser only ever shows, never runs, and plain text. */
const inertTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "text/plain"]);

/**
 * The type an Attachment is served with: its own when it is inert, otherwise `application/octet-stream`, so nothing
 * attached (HTML, SVG, scripts) ever runs as active content on Cronk's origin.
 */
const servedType = (mediaType: string) =>
  inertTypes.has(mediaType) ? (mediaType === "text/plain" ? "text/plain; charset=utf-8" : mediaType) : "application/octet-stream";

/** A `Content-Disposition` that saves the file under its name, with an ASCII fallback for older clients. */
function disposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

const owners: { kind: OwnerKind; path: string; param: string; name: string }[] = [
  { kind: "ticket", path: "/api/tickets/:ticketId/attachments", param: "ticketId", name: "a Ticket" },
  { kind: "document", path: "/api/documents/:documentId/attachments", param: "documentId", name: "a Document" },
  { kind: "comment", path: "/api/comments/:commentId/attachments", param: "commentId", name: "a Comment" },
];

export function attachmentRoutes(context: Context): FastifyPluginAsyncTypebox {
  const { limitBytes } = context.config.attachments;

  return async (app) => {
    // An attached file comes as the request's body itself, of whatever type it is; it is read here, refused past the limit.
    app.removeAllContentTypeParsers();
    app.addContentTypeParser("*", (request, payload, done) => {
      const declared = Number(request.headers["content-length"]);
      if (declared > limitBytes) return done(attachmentTooLarge(limitBytes), undefined);
      const chunks: Buffer[] = [];
      let size = 0;
      payload.on("data", (chunk: Buffer) => {
        size += chunk.length;
        // Past the limit the rest is read and dropped, so the refusal reaches the client.
        if (size <= limitBytes) chunks.push(chunk);
      });
      payload.on("error", (error) => done(error, undefined));
      payload.on("end", () => {
        if (size > limitBytes) done(attachmentTooLarge(limitBytes), undefined);
        else done(null, Buffer.concat(chunks));
      });
    });

    for (const owner of owners) {
      const params = Type.Object({ [owner.param]: Type.String() });
      const ownerOf = (request: { params: unknown }) => ({
        kind: owner.kind,
        id: (request.params as Record<string, string>)[owner.param]!,
      });

      app.get(
        owner.path,
        {
          schema: {
            tags,
            summary: `What is attached to ${owner.name}`,
            description: "Its Attachments, oldest first, without their bytes; download one from its `content` path.",
            params,
            response: { 200: Type.Array(Attachment), 401: ErrorBody, 404: ErrorBody },
          },
        },
        async (request) => attachmentsOn(context.db, await requireCaller(context, request), ownerOf(request)),
      );

      app.post(
        owner.path,
        {
          schema: {
            tags,
            summary: `Attach a file to ${owner.name}`,
            description:
              "The request's body is the file, sent with its media type as `Content-Type`, and its name as `name`. " +
              "A file over the size limit Cronk is configured with (25 MB by default) is refused with " +
              "`attachment_too_large`, naming the limit. Users attach to any Ticket or Document, and to their own " +
              "Comments; Agents to a Document, to their own Comments, and to a Ticket during their running Run on " +
              "it or while it is a Discovered Ticket they filed that waits for a User.",
            params,
            querystring: Type.Object({ name: Type.String({ minLength: 1, maxLength: 255, pattern: "\\S" }) }),
            consumes: ["*/*"],
            response: {
              201: Attachment,
              400: ErrorBody,
              401: ErrorBody,
              403: ErrorBody,
              404: ErrorBody,
              413: ErrorBody,
            },
          },
        },
        async (request, reply) => {
          const caller = await requireCaller(context, request);
          if (!Buffer.isBuffer(request.body)) {
            throw new ApiError(400, "file_needed", "The request's body is the file to attach, with its media type as `Content-Type`.");
          }
          const attachment = await addAttachment(context, caller, ownerOf(request), {
            name: request.query.name.trim(),
            mediaType: mediaTypeOf(request.headers["content-type"]),
            bytes: request.body,
          });
          return reply.code(201).send(attachment);
        },
      );
    }

    const AttachmentParams = Type.Object({ attachmentId: Type.String() });

    app.get(
      "/api/attachments/:attachmentId/content",
      {
        schema: {
          tags,
          summary: "Download an Attachment",
          description:
            "The file, for whoever can read what it's attached to, as a download (`Content-Disposition: attachment`). " +
            "Pictures (PNG, JPEG, GIF, WebP, AVIF) and plain text keep their media type; anything else is served as " +
            "`application/octet-stream`, sandboxed, so an attached page or script never runs on Cronk's origin. " +
            "Markdown refers to an Attachment as `attachment:<id>`, which clients resolve to this path.",
          params: AttachmentParams,
          produces: ["application/octet-stream"],
          response: { 200: Type.Any({ description: "The file." }), 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request, reply) => {
        const caller = await requireCaller(context, request);
        const { attachment, content } = await attachmentContent(context, caller, request.params.attachmentId);
        return reply
          .header("content-type", servedType(attachment.mediaType))
          .header("content-length", attachment.size)
          .header("content-disposition", disposition(attachment.name))
          .header("x-content-type-options", "nosniff")
          .header("content-security-policy", "default-src 'none'; sandbox")
          .header("cache-control", "private, no-cache")
          .send(content);
      },
    );

    app.delete(
      "/api/attachments/:attachmentId",
      {
        schema: {
          tags,
          summary: "Remove an Attachment",
          description:
            "Removes the file, for whoever may attach to what it's attached to; an Agent removes only Attachments it " +
            "added itself.",
          params: AttachmentParams,
          response: { 204: Type.Null(), 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
        },
      },
      async (request, reply) => {
        await removeAttachment(context, await requireCaller(context, request), request.params.attachmentId);
        return reply.code(204).send(null);
      },
    );
  };
}
