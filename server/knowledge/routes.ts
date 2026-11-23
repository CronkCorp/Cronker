import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { warnAgent, withAvoidedWords } from "../http/avoided-words.js";
import { ErrorBody } from "../http/errors.js";
import { requireCaller } from "../identity/callers.js";
import {
  compareVersions,
  Comparison,
  createDocument,
  deleteDocument,
  Document,
  DocumentCreate,
  DocumentEdit,
  documentNotFound,
  DocumentSection,
  DocumentSummary,
  editDocument,
  findDocument,
  placeOfDocument,
  readSection,
  readVersion,
  replaceDocumentSection,
  SectionName,
  SectionReplace,
  treeOf,
  Version,
  versionsOf,
  VersionWithBody,
} from "./documents.js";
import {
  addDocumentComment,
  Comment,
  commentsOnDocument,
  DocumentCommentCreate,
  resolveDocumentThread,
} from "../work/comments.js";

/** Whether a Document's read includes its resolved threads. */
const CommentsQuery = Type.Object({
  resolved: Type.Optional(Type.Boolean({ description: "Include resolved threads, with their replies.", default: false })),
});

/** A Document as its read gives it: at its current Version, with its Comments. */
const DocumentRead = Type.Object({
  ...Document.properties,
  comments: Type.Array(Comment, { description: "Its Comments, oldest first; a reply names the Comment it answers." }),
});
import { knowledgePlaces, placeOfComment } from "./places.js";
import { OutdatedVersionBody } from "./versions.js";
import { DocumentLink, linkDocument, LinkedDocument, unlinkDocument } from "./linked-documents.js";
import { LinkedDocumentWithThreads, linkedDocumentsWithThreads } from "./ticket-threads.js";

const tags = ["Documents"];
const DocumentParams = Type.Object({ documentId: Type.String() });
const VersionNumber = Type.Integer({ minimum: 1 });

/** A Section refused as missing or ambiguous names the Document's headings or the candidates, as paths. */
const SectionRefusal = Type.Object({
  error: Type.Object({
    ...OutdatedVersionBody("Document", VersionWithBody).properties.error.properties,
    candidates: Type.Optional(
      Type.Array(Type.String(), { description: "For `section_ambiguous`: the matching Sections, as paths." }),
    ),
    headings: Type.Optional(
      Type.Array(Type.String(), { description: "For `section_not_found`: the Document's headings, as paths." }),
    ),
  }),
});
const sectionRules =
  "A Section is a heading of any level with everything up to the next heading of the same or a higher level, its " +
  "subsections included; a line that looks like a heading inside a code block, quote or list isn't one. It is named " +
  "by its heading's text, or by a path joining headings with `/`, such as `Install/Linux`, compared exactly. A name " +
  "matching several Sections is refused with `section_ambiguous`, naming them as paths in `candidates`; one matching " +
  "none with `section_not_found`, listing the Document's headings as paths in `headings`.";

export function knowledgeRoutes(context: Context): FastifyPluginAsyncTypebox {
  const { db } = context;

  return async (app) => {
    // A Project's page tree and the Workspace's are reached the same way, each from its own path.
    const trees = knowledgePlaces(db).map((place) => ({ ...place, path: `${place.path}/documents` }));
    for (const tree of trees) {
      const { params } = tree;

      app.get(
        tree.path,
        {
          schema: {
            tags,
            summary: `${tree.name[0]!.toUpperCase()}${tree.name.slice(1)} page tree`,
            description:
              "Its Documents without their bodies, in tree order: each right after its parent, siblings by their " +
              "place. A Project's page tree and the Workspace's are separate.",
            params,
            response: { 200: Type.Array(DocumentSummary), 401: ErrorBody, 404: ErrorBody },
          },
        },
        async (request) => treeOf(db, await tree.find(request, await requireCaller(context, request))),
      );

      app.post(
        tree.path,
        {
          schema: {
            tags,
            summary: `Create a Document in ${tree.name} page tree`,
            description:
              "Creates the Document under a parent of the same page tree, or at its top, at Version 1 by its Actor.",
            params,
            body: DocumentCreate,
            response: {
              201: withAvoidedWords(Document),
              400: ErrorBody,
              401: ErrorBody,
              403: ErrorBody,
              404: ErrorBody,
              409: ErrorBody,
            },
          },
        },
        async (request, reply) => {
          const caller = await requireCaller(context, request);
          const { body = "", ...input } = request.body;
          const created = await createDocument(context, caller, await tree.find(request, caller), { ...input, body });
          return reply.code(201).send(await warnAgent(db, caller, created, { plain: [input.title], markdown: [body] }, created));
        },
      );
    }

    app.get(
      "/api/documents/:documentId",
      {
        schema: {
          tags,
          summary: "A Document at its current Version, with its Comments",
          description:
            "Its Comments are oldest first, a reply naming the Comment it answers, as its Comments route lists them: " +
            "resolved threads left out unless `resolved=true` asks for them.",
          params: DocumentParams,
          querystring: CommentsQuery,
          response: { 200: DocumentRead, 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const caller = await requireCaller(context, request);
        const document = await findDocument(db, caller, request.params.documentId);
        if (!document) throw documentNotFound();
        return {
          ...document,
          comments: await commentsOnDocument(db, caller, document.id, { includeResolved: request.query.resolved }),
        };
      },
    );

    app.get(
      "/api/documents/:documentId/comments",
      {
        schema: {
          tags,
          summary: "A Document's Comments",
          description:
            "Oldest first. A reply names the Comment it answers. A Report is a Document, and has Comments too. A " +
            "resolved thread, with its replies, is left out unless `resolved=true` asks for it.",
          params: DocumentParams,
          querystring: CommentsQuery,
          response: { 200: Type.Array(Comment), 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) =>
        commentsOnDocument(db, await requireCaller(context, request), request.params.documentId, {
          includeResolved: request.query.resolved,
        }),
    );

    for (const [action, resolved] of [
      ["resolve", true],
      ["unresolve", false],
    ] as const) {
      app.post(
        `/api/comments/:commentId/${action}`,
        {
          schema: {
            tags,
            summary: resolved ? "Resolve a thread on a Document" : "Unresolve a thread on a Document",
            description: resolved
              ? "A User with Write resolves the thread a Document's Comment starts once its review is dealt with, " +
                "recording when and by whom; it is then left out of the Document's read unless asked for. Agents " +
                "are refused. Resolving a resolved thread changes nothing."
              : "A User with Write unresolves a resolved thread on a Document, so its read shows it again. Agents " +
                "are refused. Unresolving an open thread changes nothing.",
            params: Type.Object({ commentId: Type.String() }),
            response: { 200: Comment, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
          },
        },
        async (request) =>
          resolveDocumentThread(context, await requireCaller(context, request), request.params.commentId, resolved),
      );
    }

    app.post(
      "/api/documents/:documentId/comments",
      {
        schema: {
          tags,
          summary: "Comment on a Document, or reply to one of its Comments",
          description:
            "Users and Agents with a full token may comment on a Document they can change, as on a Ticket, a Report " +
            "included. Its readers see it live; nobody is notified of it. A `quote` anchors its thread to a passage of " +
            "the current Version, refused with `quote_not_found` when the passage isn't in it; its reads then give " +
            "the passage's `anchor`, `outdated` once the passage is edited away. An Agent's Comment answers with " +
            "`avoidedWords`: the words the Document's glossary avoids that its body uses.",
          params: DocumentParams,
          body: DocumentCommentCreate,
          response: { 201: withAvoidedWords(Comment), 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
        },
      },
      async (request, reply) => {
        const caller = await requireCaller(context, request);
        const comment = await addDocumentComment(context, caller, request.params.documentId, request.body);
        const place = await placeOfComment(db, comment);
        return reply.code(201).send(await warnAgent(db, caller, place, { markdown: [request.body.body] }, comment));
      },
    );

    app.patch(
      "/api/documents/:documentId",
      {
        schema: {
          tags,
          summary: "Save, rename or move a Document",
          description:
            "A new title or body saves the Document as its next Version, by the caller, and needs `baseVersion`: the " +
            "number of the Version it's based on. A save based on an outdated Version is refused with " +
            "`outdated_version`, carrying the current Version as `current`. A new parent or place moves it within " +
            "its page tree, making no Version; it can't move under itself or one of its own descendants. A Report " +
            "is listed with its Ticket, not in a page tree, so moving one is refused with `report_outside_tree`.",
          params: DocumentParams,
          body: DocumentEdit,
          response: {
            200: withAvoidedWords(Document),
            400: ErrorBody,
            401: ErrorBody,
            403: ErrorBody,
            404: ErrorBody,
            409: OutdatedVersionBody("Document", VersionWithBody),
          },
        },
      },
      async (request) => {
        const caller = await requireCaller(context, request);
        const saved = await editDocument(context, caller, request.params.documentId, request.body);
        const { title, body } = request.body;
        const texts = { plain: title === undefined ? [] : [title], markdown: body === undefined ? [] : [body] };
        return warnAgent(db, caller, saved, texts, saved);
      },
    );

    app.get(
      "/api/documents/:documentId/sections",
      {
        schema: {
          tags,
          summary: "One Section of a Document",
          description: `The Section at the Document's current Version, whose number a replace names as its base. ${sectionRules}`,
          params: DocumentParams,
          querystring: Type.Object({ section: SectionName }),
          response: { 200: DocumentSection, 400: ErrorBody, 401: ErrorBody, 404: SectionRefusal, 409: SectionRefusal },
        },
      },
      async (request) =>
        readSection(db, await requireCaller(context, request), request.params.documentId, request.query.section),
    );

    app.put(
      "/api/documents/:documentId/sections",
      {
        schema: {
          tags,
          summary: "Replace one Section of a Document",
          description:
            "Replaces the Section with `body`, saving the Document as its next Version by the caller, as a whole save " +
            "does; the rest of the Document stays as it was. It names the Version it's based on as `baseVersion`: one " +
            "based on an outdated Version is refused with `outdated_version`, carrying the current Version as " +
            "`current`. The new body starts with a heading of the Section's own level, whose text may change, and " +
            "holds no other heading of that level or a higher one, or it is refused with `section_heading_level`. " +
            `Answers the Section as replaced. ${sectionRules}`,
          params: DocumentParams,
          body: SectionReplace,
          response: {
            200: withAvoidedWords(DocumentSection),
            400: ErrorBody,
            401: ErrorBody,
            403: ErrorBody,
            404: SectionRefusal,
            409: SectionRefusal,
          },
        },
      },
      async (request) => {
        const caller = await requireCaller(context, request);
        const replaced = await replaceDocumentSection(context, caller, request.params.documentId, request.body);
        const place = await placeOfDocument(db, replaced.documentId);
        return warnAgent(db, caller, place, { markdown: [request.body.body] }, replaced);
      },
    );

    app.delete(
      "/api/documents/:documentId",
      {
        schema: {
          tags,
          summary: "Delete a Document",
          description:
            "Deletes the Document with all its Versions. Only a User, or an Agent with a Full token, may; an Agent with a Write token is refused with `full_token_needed`. " +
            "Refused with `document_has_children` while Documents sit under it: move or delete them first.",
          params: DocumentParams,
          response: { 204: Type.Null(), 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request, reply) => {
        await deleteDocument(context, await requireCaller(context, request), request.params.documentId);
        return reply.code(204).send(null);
      },
    );

    const TicketParams = Type.Object({ ticketId: Type.String() });

    app.get(
      "/api/tickets/:ticketId/documents",
      {
        schema: {
          tags: ["Tickets"],
          summary: "A Ticket's Linked Documents",
          description:
            "Documents of the Ticket's Project or of the Workspace linked to it, oldest link first, each with its " +
            "unresolved threads.",
          params: TicketParams,
          response: { 200: Type.Array(LinkedDocumentWithThreads), 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => linkedDocumentsWithThreads(db, await requireCaller(context, request), request.params.ticketId),
    );

    app.post(
      "/api/tickets/:ticketId/documents",
      {
        schema: {
          tags: ["Tickets"],
          summary: "Link a Document to a Ticket",
          description:
            "Links a Document of the Ticket's Project or of the Workspace (`document_outside_project` for another " +
            "Project's; `unknown_document` for one not in the Workspace), once (`document_already_linked`). An Agent " +
            "links only during its own running Run on the Ticket, or on a Discovered Ticket it filed that still waits " +
            "for a User (`no_running_run`; `not_your_discovered_ticket` for another Agent's or a settled one). A " +
            "deleted Document drops out of its links.",
          params: TicketParams,
          body: DocumentLink,
          response: { 201: LinkedDocument, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request, reply) => {
        const caller = await requireCaller(context, request);
        const linked = await linkDocument(context, caller, request.params.ticketId, request.body.documentId);
        return reply.code(201).send(linked);
      },
    );

    app.delete(
      "/api/tickets/:ticketId/documents/:documentId",
      {
        schema: {
          tags: ["Tickets"],
          summary: "Unlink a Document from a Ticket",
          description:
            "The Document stays in its page tree; a Document the Ticket doesn't link answers `not_found`. An Agent " +
            "unlinks only during its own running Run on the Ticket, or on a Discovered Ticket it filed that still " +
            "waits for a User (`no_running_run`; `not_your_discovered_ticket` for another Agent's " +
            "or a settled one).",
          params: Type.Object({ ticketId: Type.String(), documentId: Type.String() }),
          response: { 204: Type.Null(), 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
        },
      },
      async (request, reply) => {
        const caller = await requireCaller(context, request);
        await unlinkDocument(context, caller, request.params.ticketId, request.params.documentId);
        return reply.code(204).send(null);
      },
    );

    app.get(
      "/api/documents/:documentId/versions",
      {
        schema: {
          tags,
          summary: "A Document's Versions, oldest first",
          description: "Each Version's number, title, Actor and time, without its body; read one for its body.",
          params: DocumentParams,
          response: { 200: Type.Array(Version), 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => versionsOf(db, await requireCaller(context, request), request.params.documentId),
    );

    app.get(
      "/api/documents/:documentId/versions/compare",
      {
        schema: {
          tags,
          summary: "Compare two of a Document's Versions",
          description: "Both Versions, and their bodies compared line by line from `from` to `to`.",
          params: DocumentParams,
          querystring: Type.Object({ from: VersionNumber, to: VersionNumber }),
          response: { 200: Comparison, 400: ErrorBody, 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) =>
        compareVersions(db, await requireCaller(context, request), request.params.documentId, request.query),
    );

    app.get(
      "/api/documents/:documentId/versions/:number",
      {
        schema: {
          tags,
          summary: "One of a Document's Versions, with its body",
          params: Type.Object({ documentId: Type.String(), number: VersionNumber }),
          response: { 200: VersionWithBody, 400: ErrorBody, 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) =>
        readVersion(db, await requireCaller(context, request), request.params.documentId, request.params.number),
    );
  };
}
