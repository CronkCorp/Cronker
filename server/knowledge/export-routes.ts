import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { ErrorBody } from "../http/errors.js";
import { requireCaller } from "../identity/callers.js";
import { Export, exportOf } from "./export.js";
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
              "alphabetical; its Decisions are its own. The Workspace's export holds its own Terms and Decisions. " +
              "Cronk never commits them itself.",
            params,
            response: { 200: Export, 401: ErrorBody, 404: ErrorBody },
          },
        },
        async (request) => exportOf(db, await place.find(request, await requireCaller(context, request))),
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
          const found = await place.find(request, await requireCaller(context, request));
          const { files } = await exportOf(db, found);
          const name = found.label.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "export";
          return reply
            .type("application/zip")
            .header("content-disposition", `attachment; filename="${name}-knowledge.zip"`)
            .send(zip(files));
        },
      );
    }
  };
}
