import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { ErrorBody } from "../http/errors.js";
import { requireCaller } from "../identity/callers.js";
import { findProject, projectNotFound } from "../work/projects.js";
import { knowledgePlaces } from "./places.js";
import { OutdatedVersionBody } from "./versions.js";
import {
  compareTermVersions,
  createTerm,
  deleteTerm,
  editTerm,
  findTerm,
  glossaryOf,
  readTermVersion,
  Term,
  TermComparison,
  TermDetail,
  termNotFound,
  termsOf,
  withMentions,
  TermVersion,
  versionsOf,
} from "./terms.js";

const Name = Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" });
const Definition = Type.String({ maxLength: 20_000, description: "Markdown." });
const Avoid = Type.Array(Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" }), {
  maxItems: 50,
  description: "Words to avoid in the Term's place, in the order given.",
});
const tags = ["Terms"];
const TermParams = Type.Object({ termId: Type.String() });
const VersionNumber = Type.Integer({ minimum: 1 });

/** Trims the name and each word to avoid, as they are kept. */
const tidy = <T extends { name?: string; avoid?: string[] }>(input: T): T => ({
  ...input,
  ...(input.name !== undefined && { name: input.name.trim() }),
  ...(input.avoid !== undefined && { avoid: input.avoid.map((word) => word.trim()) }),
});

export function termRoutes(context: Context): FastifyPluginAsyncTypebox {
  const { db } = context;

  return async (app) => {
    for (const place of knowledgePlaces(db)) {
      const { params } = place;
      const path = `${place.path}/terms`;

      app.get(
        path,
        {
          schema: {
            tags,
            summary: `${place.name[0]!.toUpperCase()}${place.name.slice(1)} own Terms`,
            description:
              "Its own Terms at their current Versions, by name ignoring case. A Project's own Terms leave out the " +
              "Workspace's; its glossary shows both.",
            params,
            response: { 200: Type.Array(Term), 401: ErrorBody, 404: ErrorBody },
          },
        },
        async (request) => {
          const caller = await requireCaller(context, request);
          return withMentions(db, caller, await termsOf(db, await place.find(request, caller)));
        },
      );

      app.post(
        path,
        {
          schema: {
            tags,
            summary: `Create a Term in ${place.name} glossary`,
            description:
              "Creates the Term at Version 1 by its Actor. Its name is unique ignoring case among the Project's own " +
              "Terms, or the Workspace's: a taken one is refused with `term_name_taken`.",
            params,
            body: Type.Object({ name: Name, definition: Type.Optional(Definition), avoid: Type.Optional(Avoid) }),
            response: { 201: TermDetail, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
          },
        },
        async (request, reply) => {
          const caller = await requireCaller(context, request);
          const { definition = "", avoid = [], name } = tidy(request.body);
          const created = await createTerm(context, caller, await place.find(request, caller), { name, definition, avoid });
          return reply.code(201).send(created);
        },
      );
    }

    app.get(
      "/api/projects/:projectId/glossary",
      {
        schema: {
          tags,
          summary: "A Project's glossary",
          description:
            "The Project's own Terms over the Workspace's, by name ignoring case: a Project Term replaces a Workspace " +
            "Term of the same name, ignoring case. Each Term's `projectId` says whose it is.",
          params: Type.Object({ projectId: Type.String() }),
          response: { 200: Type.Array(Term), 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const caller = await requireCaller(context, request);
        const project = await findProject(db, caller, request.params.projectId);
        if (!project) throw projectNotFound();
        return withMentions(db, caller, await glossaryOf(db, { workspaceId: project.workspaceId, projectId: project.id }));
      },
    );

    app.get(
      "/api/terms/:termId",
      {
        schema: {
          tags,
          summary: "A Term at its current Version",
          description: "With `mentionedIn`, the texts mentioning it that the caller may read.",
          params: TermParams,
          response: { 200: TermDetail, 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const term = await findTerm(db, await requireCaller(context, request), request.params.termId);
        if (!term) throw termNotFound();
        return term;
      },
    );

    app.patch(
      "/api/terms/:termId",
      {
        schema: {
          tags,
          summary: "Save a Term",
          description:
            "Saves the Term as its next Version, by the caller, keeping what the save leaves out; a new name another " +
            "Term of its glossary has, ignoring case, is refused with `term_name_taken`. `baseVersion` is the " +
            "number of the Version the save is based on. A save based on an outdated Version is refused with " +
            "`outdated_version`, carrying the current Version as `current`.",
          params: TermParams,
          body: Type.Object({
            baseVersion: Type.Integer({ minimum: 1, description: "The Version the save is based on." }),
            name: Type.Optional(Name),
            definition: Type.Optional(Definition),
            avoid: Type.Optional(Avoid),
          }),
          response: { 200: TermDetail, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: OutdatedVersionBody("Term", TermVersion) },
        },
      },
      async (request) => editTerm(context, await requireCaller(context, request), request.params.termId, tidy(request.body)),
    );

    app.get(
      "/api/terms/:termId/versions",
      {
        schema: {
          tags,
          summary: "A Term's Versions, oldest first",
          description: "Each Version's name, definition and words to avoid, with the Actor who saved it and when.",
          params: TermParams,
          response: { 200: Type.Array(TermVersion), 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => versionsOf(db, await requireCaller(context, request), request.params.termId),
    );

    app.get(
      "/api/terms/:termId/versions/compare",
      {
        schema: {
          tags,
          summary: "Compare two of a Term's Versions",
          description:
            "Both Versions, with their names; their definitions compared line by line from `from` to `to`; and their " +
            "words to avoid compared one by one.",
          params: TermParams,
          querystring: Type.Object({ from: VersionNumber, to: VersionNumber }),
          response: { 200: TermComparison, 400: ErrorBody, 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => compareTermVersions(db, await requireCaller(context, request), request.params.termId, request.query),
    );

    app.get(
      "/api/terms/:termId/versions/:number",
      {
        schema: {
          tags,
          summary: "One of a Term's Versions",
          description: "What the Version said: its name, definition and words to avoid, with the Actor who saved it and when.",
          params: Type.Object({ termId: Type.String(), number: VersionNumber }),
          response: { 200: TermVersion, 400: ErrorBody, 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) =>
        readTermVersion(db, await requireCaller(context, request), request.params.termId, request.params.number),
    );

    app.delete(
      "/api/terms/:termId",
      {
        schema: {
          tags,
          summary: "Delete a Term",
          description: "Deletes the Term with all its Versions. Only a User may; Agents are refused with `agent_not_allowed`.",
          params: TermParams,
          response: { 204: Type.Null(), 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
        },
      },
      async (request, reply) => {
        await deleteTerm(context, await requireCaller(context, request), request.params.termId);
        return reply.code(204).send(null);
      },
    );
  };
}
