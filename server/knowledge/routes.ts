import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { ErrorBody } from "../http/errors.js";
import { requireCaller } from "../identity/callers.js";
import { findProject, projectNotFound } from "../work/projects.js";
import { createDocument, Document, documentNotFound, editDocument, findDocument, VersionWithBody } from "./documents.js";

const Title = Type.String({ minLength: 1, maxLength: 300, pattern: "\\S" });
const Body = Type.String({ maxLength: 500_000, description: "Markdown." });
const tags = ["Documents"];

/** A save refused for being based on an outdated Version, with the current Version to merge into. */
const OutdatedVersionBody = Type.Object({
  error: Type.Object({
    ...ErrorBody.properties.error.properties,
    current: Type.Optional(Type.Object(VersionWithBody.properties, { description: "The Document's current Version." })),
  }),
});

export function knowledgeRoutes(context: Context): FastifyPluginAsyncTypebox {
  const { db } = context;

  return async (app) => {
    app.post(
      "/api/projects/:projectId/documents",
      {
        schema: {
          tags,
          summary: "Create a Document in a Project's page tree",
          description: "Creates the Document last at the top of the Project's page tree, at Version 1 by its Actor.",
          params: Type.Object({ projectId: Type.String() }),
          body: Type.Object({ title: Title, body: Type.Optional(Body) }),
          response: { 201: Document, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
        },
      },
      async (request, reply) => {
        const caller = await requireCaller(context, request);
        const project = await findProject(db, caller, request.params.projectId);
        if (!project) throw projectNotFound();
        const { title, body = "" } = request.body;
        const tree = { workspaceId: project.workspaceId, projectId: project.id };
        return reply.code(201).send(await createDocument(context, caller, tree, { title, body }));
      },
    );

    app.get(
      "/api/documents/:documentId",
      {
        schema: {
          tags,
          summary: "A Document at its current Version",
          params: Type.Object({ documentId: Type.String() }),
          response: { 200: Document, 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const caller = await requireCaller(context, request);
        const document = await findDocument(db, caller, request.params.documentId);
        if (!document) throw documentNotFound();
        return document;
      },
    );

    app.patch(
      "/api/documents/:documentId",
      {
        schema: {
          tags,
          summary: "Save a Document",
          description:
            "A new title or body saves the Document as its next Version, by the caller, and needs `baseVersion`: the " +
            "number of the Version it's based on. A save based on an outdated Version is refused with " +
            "`outdated_version`, carrying the current Version as `current`.",
          params: Type.Object({ documentId: Type.String() }),
          body: Type.Object({
            baseVersion: Type.Optional(Type.Integer({ minimum: 1, description: "The Version the save is based on." })),
            title: Type.Optional(Title),
            body: Type.Optional(Body),
          }),
          response: { 200: Document, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: OutdatedVersionBody },
        },
      },
      async (request) => editDocument(context, await requireCaller(context, request), request.params.documentId, request.body),
    );
  };
}
