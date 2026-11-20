import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { ErrorBody } from "../http/errors.js";
import { requireCaller } from "../identity/callers.js";
import { knowledgePlaces } from "../knowledge/places.js";
import { Artifact, ArtifactFileContent, artifactNotFound, artifactTooLarge, readArtifactFile, artifactsIn, ArtifactSummary, ArtifactVersion, createArtifact, findArtifact, saveArtifact } from "./artifacts.js";
import { OutdatedVersionBody } from "../knowledge/versions.js";

const tags = ["Artifacts"];
const Title = Type.String({ minLength: 1, maxLength: 300, pattern: "\\S" });
const Description = Type.String({ maxLength: 10_000 });
const FilePath = Type.String({
  minLength: 1,
  maxLength: 500,
  description: "A path relative to the Version, such as `index.html` or `scripts/app.js`.",
});
const FileInput = Type.Object({
  path: FilePath,
  contentBase64: Type.String({ description: "The file's bytes, in standard base64." }),
  mediaType: Type.Optional(
    Type.String({ description: "The media type to serve it with; from its extension when left out, such as `text/html` for `.html`." }),
  ),
});
const ArtifactParams = Type.Object({ artifactId: Type.String() });

export function artifactRoutes(context: Context): FastifyPluginAsyncTypebox {
  const { db } = context;
  // A save carries its files as base64, a third larger than their bytes.
  const bodyLimit = Math.ceil(context.config.attachments.limitBytes / 3) * 4 + 1024 * 1024;

  return async (app) => {
    // A body too large to read holds files over the limit: it is refused as such, with the rule and what to do.
    app.setErrorHandler((error, _request, _reply) => {
      if ((error as { code?: string }).code === "FST_ERR_CTP_BODY_TOO_LARGE") {
        throw artifactTooLarge(context.config.attachments.limitBytes);
      }
      throw error;
    });

    const places = knowledgePlaces(db).map((place) => ({ ...place, path: `${place.path}/artifacts` }));
    for (const place of places) {
      app.get(
        place.path,
        {
          schema: {
            tags,
            summary: `${place.name[0]!.toUpperCase()}${place.name.slice(1)} Artifacts`,
            description:
              "Its Artifacts at their current Versions, last changed first, without their files. A Project's " +
              "Artifacts and the Workspace's are separate.",
            params: place.params,
            response: { 200: Type.Array(ArtifactSummary), 401: ErrorBody, 404: ErrorBody },
          },
        },
        async (request) => artifactsIn(db, await place.find(request, await requireCaller(context, request))),
      );

      app.post(
        place.path,
        {
          bodyLimit,
          schema: {
            tags,
            summary: `Create an Artifact in ${place.name.replace(/'s$/, "")}`,
            description:
              "Creates an Artifact at Version 1 by its Actor: a title, a description, and its files, each by a path " +
              "relative to the Version and its bytes as base64. `page` names the file that is its page " +
              "(`index.html` when left out); the page refers to the others by relative paths.",
            params: place.params,
            body: Type.Object({
              title: Title,
              description: Type.Optional(Description),
              page: Type.Optional(FilePath),
              files: Type.Array(FileInput, { maxItems: 1000 }),
            }),
            response: { 201: Artifact, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 413: ErrorBody },
          },
        },
        async (request, reply) => {
          const caller = await requireCaller(context, request);
          const created = await createArtifact(context, caller, await place.find(request, caller), request.body);
          return reply.code(201).send(created);
        },
      );
    }

    app.get(
      "/api/artifacts/:artifactId",
      {
        schema: {
          tags,
          summary: "An Artifact at its current Version",
          description: "Its title, description, page and files, without their bytes, and the address its page is served at.",
          params: ArtifactParams,
          response: { 200: Artifact, 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const artifact = await findArtifact(db, await requireCaller(context, request), request.params.artifactId);
        if (!artifact) throw artifactNotFound();
        return artifact;
      },
    );

    app.get(
      "/api/artifacts/:artifactId/file",
      {
        schema: {
          tags,
          summary: "Read a file of an Artifact",
          description: "A file of the Artifact's current Version, by its path, with its bytes as base64.",
          params: ArtifactParams,
          querystring: Type.Object({ path: FilePath }),
          response: { 200: ArtifactFileContent, 400: ErrorBody, 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) =>
        readArtifactFile(context, await requireCaller(context, request), request.params.artifactId, request.query.path),
    );

    app.patch(
      "/api/artifacts/:artifactId",
      {
        bodyLimit,
        schema: {
          tags,
          summary: "Save an Artifact",
          description:
            "Saves the Artifact as its next Version, by the caller, holding the whole set of files: the current " +
            "Version's, with `files` added or replacing those at the same paths, and those named in `remove` taken " +
            "out; a new title, description or page may come with it. A save needs `baseVersion`, the number of the " +
            "Version it's based on; one based on an outdated Version is refused with `outdated_version`, carrying the " +
            "current Version as `current`. Each Version is served from its own address, so earlier ones stay as they " +
            "were.",
          params: ArtifactParams,
          body: Type.Object({
            baseVersion: Type.Optional(Type.Integer({ minimum: 1, description: "The Version the save is based on." })),
            title: Type.Optional(Title),
            description: Type.Optional(Description),
            page: Type.Optional(FilePath),
            files: Type.Optional(Type.Array(FileInput, { maxItems: 1000, description: "Files to add, or to replace at their paths." })),
            remove: Type.Optional(Type.Array(FilePath, { maxItems: 1000, description: "Paths of files to remove." })),
          }),
          response: {
            200: Artifact,
            400: ErrorBody,
            401: ErrorBody,
            403: ErrorBody,
            404: ErrorBody,
            409: OutdatedVersionBody("Artifact", ArtifactVersion),
            413: ErrorBody,
          },
        },
      },
      async (request) => saveArtifact(context, await requireCaller(context, request), request.params.artifactId, request.body),
    );
  };
}
