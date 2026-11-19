import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { ApiError, ErrorBody } from "../http/errors.js";
import { requireCaller, type Caller } from "../identity/callers.js";
import { findWorkspace } from "../workspaces/workspaces.js";
import { findProject, projectNotFound } from "../work/projects.js";
import {
  compareVersions,
  Comparison,
  createDocument,
  deleteDocument,
  Document,
  documentNotFound,
  DocumentSummary,
  editDocument,
  findDocument,
  readVersion,
  treeOf,
  type Tree,
  Version,
  versionsOf,
  VersionWithBody,
} from "./documents.js";

const Title = Type.String({ minLength: 1, maxLength: 300, pattern: "\\S" });
const Body = Type.String({ maxLength: 500_000, description: "Markdown." });
const tags = ["Documents"];
const DocumentParams = Type.Object({ documentId: Type.String() });
const VersionNumber = Type.Integer({ minimum: 1 });
const ParentId = Type.Union([Type.Null(), Type.String()], {
  description: "A Document of the same page tree to sit under, or null for the top.",
});
const Position = Type.Integer({
  minimum: 0,
  description: "A place among its siblings, counting from 0; last when left out or past the end.",
});

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
    // A Project's page tree and the Workspace's are reached the same way, each from its own path.
    const trees = [
      {
        path: "/api/projects/:projectId/documents",
        params: Type.Object({ projectId: Type.String() }),
        name: "a Project's",
        async find(request: FastifyRequest, caller: Caller): Promise<Tree> {
          const project = await findProject(db, caller, (request.params as { projectId: string }).projectId);
          if (!project) throw projectNotFound();
          return { workspaceId: project.workspaceId, projectId: project.id };
        },
      },
      {
        path: "/api/workspaces/:workspaceId/documents",
        params: Type.Object({ workspaceId: Type.String() }),
        name: "the Workspace's",
        async find(request: FastifyRequest, caller: Caller): Promise<Tree> {
          const workspace = await findWorkspace(db, caller, (request.params as { workspaceId: string }).workspaceId);
          if (!workspace) throw new ApiError(404, "not_found", "No such Workspace.");
          return { workspaceId: workspace.id, projectId: null };
        },
      },
    ];
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
            body: Type.Object({
              title: Title,
              body: Type.Optional(Body),
              parentId: Type.Optional(ParentId),
              position: Type.Optional(Position),
            }),
            response: { 201: Document, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
          },
        },
        async (request, reply) => {
          const caller = await requireCaller(context, request);
          const { body = "", ...input } = request.body;
          const created = await createDocument(context, caller, await tree.find(request, caller), { ...input, body });
          return reply.code(201).send(created);
        },
      );
    }

    app.get(
      "/api/documents/:documentId",
      {
        schema: {
          tags,
          summary: "A Document at its current Version",
          params: DocumentParams,
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
          summary: "Save, rename or move a Document",
          description:
            "A new title or body saves the Document as its next Version, by the caller, and needs `baseVersion`: the " +
            "number of the Version it's based on. A save based on an outdated Version is refused with " +
            "`outdated_version`, carrying the current Version as `current`. A new parent or place moves it within " +
            "its page tree, making no Version; it can't move under itself or one of its own descendants. A Report " +
            "is listed with its Ticket, not in a page tree, so moving one is refused with `report_outside_tree`.",
          params: DocumentParams,
          body: Type.Object({
            baseVersion: Type.Optional(Type.Integer({ minimum: 1, description: "The Version the save is based on." })),
            title: Type.Optional(Title),
            body: Type.Optional(Body),
            parentId: Type.Optional(ParentId),
            position: Type.Optional(Position),
          }),
          response: { 200: Document, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: OutdatedVersionBody },
        },
      },
      async (request) => editDocument(context, await requireCaller(context, request), request.params.documentId, request.body),
    );

    app.delete(
      "/api/documents/:documentId",
      {
        schema: {
          tags,
          summary: "Delete a Document",
          description:
            "Deletes the Document with all its Versions. Only a User may; Agents are refused with `agent_not_allowed`. " +
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
