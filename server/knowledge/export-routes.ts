import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { disposition } from "../http/disposition.js";
import { ErrorBody } from "../http/errors.js";
import { requireCaller } from "../identity/callers.js";
import { Export, exportOf, hyphenate } from "./export.js";
import { knowledgePlaces } from "./places.js";
import { zip } from "./zip.js";

const tags = ["Export"];

export function exportRoutes(context: Context): FastifyPluginAsyncTypebox {
  const { db } = context;

  return async (app) => {
    for (const place of knowledgePlaces(db)) {
      const { params } = place;

      app.get(
        `${place.path}/export`,
        {
          schema: {
            tags,
            summary: `Export ${place.name} Terms and Decisions`,
            description:
              "The files to commit into a Repository: `GLOSSARY.md`, then `docs/adr/NNNN-<slug>.md` for each Decision " +
              "by number. A Project's `GLOSSARY.md` holds its glossary, its own Terms over the Workspace's, " +
              "alphabetical; its Decisions are its own. The Workspace's export holds its own Terms and Decisions, never a " +
              "Project's, so it holds nothing of a private Project. " +
              "Cronk never commits them itself.",
            params,
            response: { 200: Export, 401: ErrorBody, 404: ErrorBody },
          },
        },
        async (request) => {
          const caller = await requireCaller(context, request);
          return exportOf(db, caller, await place.find(request, caller));
        },
      );

      app.get(
        `${place.path}/export.zip`,
        {
          schema: {
            tags,
            summary: `Download ${place.name} export as a zip`,
            description:
              "The same files as the export, in a zip archive at their paths, named after the Project's key or the " +
              "Workspace's name.",
            params,
            produces: ["application/zip"],
            response: { 200: Type.Any({ description: "The zip archive." }), 401: ErrorBody, 404: ErrorBody },
          },
        },
        async (request, reply) => {
          const caller = await requireCaller(context, request);
          const found = await place.find(request, caller);
          const { files } = await exportOf(db, caller, found);
          return reply
            .type("application/zip")
            .header("content-disposition", disposition(`${hyphenate(found.label) || "export"}-knowledge.zip`))
            .send(zip(files));
        },
      );
    }
  };
}
