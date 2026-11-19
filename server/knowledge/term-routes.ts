import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { ErrorBody } from "../http/errors.js";
import { requireCaller } from "../identity/callers.js";
import { knowledgePlaces } from "./places.js";
import { createTerm, editTerm, findTerm, Term, termNotFound, TermVersion, versionsOf } from "./terms.js";

const Name = Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" });
const Definition = Type.String({ maxLength: 20_000, description: "Markdown." });
const Avoid = Type.Array(Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" }), {
  maxItems: 50,
  description: "Words to avoid in the Term's place, in the order given.",
});
const tags = ["Terms"];
const TermParams = Type.Object({ termId: Type.String() });

/** A save refused for being based on an outdated Version, with the current Version to merge into. */
const OutdatedVersionBody = Type.Object({
  error: Type.Object({
    ...ErrorBody.properties.error.properties,
    current: Type.Optional(Type.Object(TermVersion.properties, { description: "The Term's current Version." })),
  }),
});

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

      app.post(
        path,
        {
          schema: {
            tags,
            summary: `Create a Term in ${place.name} glossary`,
            description:
              "Creates the Term at Version 1 by its Actor. Its name is unique ignoring case among the Project's own " +
              "Terms, or the Workspace's.",
            params,
            body: Type.Object({ name: Name, definition: Type.Optional(Definition), avoid: Type.Optional(Avoid) }),
            response: { 201: Term, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
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
      "/api/terms/:termId",
      {
        schema: {
          tags,
          summary: "A Term at its current Version",
          params: TermParams,
          response: { 200: Term, 401: ErrorBody, 404: ErrorBody },
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
            "Saves the Term as its next Version, by the caller, keeping what the save leaves out. `baseVersion` is the " +
            "number of the Version the save is based on. A save based on an outdated Version is refused with " +
            "`outdated_version`, carrying the current Version as `current`.",
          params: TermParams,
          body: Type.Object({
            baseVersion: Type.Integer({ minimum: 1, description: "The Version the save is based on." }),
            name: Type.Optional(Name),
            definition: Type.Optional(Definition),
            avoid: Type.Optional(Avoid),
          }),
          response: { 200: Term, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: OutdatedVersionBody },
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
  };
}
