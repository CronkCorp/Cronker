import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { given, warnAgent, withAvoidedWords } from "../http/avoided-words.js";
import { ErrorBody } from "../http/errors.js";
import { requireCaller } from "../identity/callers.js";
import { knowledgePlaces, placeOfComment } from "../knowledge/places.js";
import { Artifact, ArtifactCreate, ArtifactSave, FilePath, ArtifactFileContent, artifactNotFound, deleteArtifact, artifactTooLarge, readArtifactFile, artifactsIn, ArtifactSummary, ArtifactVersion, artifactVersionsOf, ArtifactComparison, compareArtifactVersions, createArtifact, deleteArtifactVersion, readArtifactVersion, ArtifactVersionRead, findArtifact, saveArtifact } from "./artifacts.js";
import { OutdatedVersionBody } from "../knowledge/versions.js";
import { addArtifactComment, Comment, commentsOnArtifact } from "../work/comments.js";
import { ArtifactLink, linkArtifact, LinkedArtifact, linkedArtifactsOf, unlinkArtifact } from "./linked-artifacts.js";

const tags = ["Artifacts"];
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
              "(`index.html` when left out); the page refers to the others by relative paths. An Agent names its " +
              "running Run as `runId` to link the Artifact to the Run's Ticket (`no_running_run` when it isn't one). An " +
              "Agent's save answers with `avoidedWords`: the words the glossary avoids that its title and description use.",
            params: place.params,
            body: ArtifactCreate,
            response: { 201: withAvoidedWords(Artifact), 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 413: ErrorBody },
          },
        },
        async (request, reply) => {
          const caller = await requireCaller(context, request);
          const created = await createArtifact(context, caller, await place.find(request, caller), request.body);
          const texts = given({ plain: [request.body.title], markdown: [request.body.description] });
          return reply.code(201).send(await warnAgent(db, caller, created, texts, created));
        },
      );
    }

    app.get(
      "/api/artifacts/:artifactId",
      {
        schema: {
          tags,
          summary: "An Artifact at its current Version, or another",
          description:
            "Its title, description, page and files, without their bytes, and the address its page is served at: at " +
            "its current Version, or at the one `version` names, as an Embed's address may. A Version it never had " +
            "answers 404.",
          params: ArtifactParams,
          querystring: Type.Object({
            version: Type.Optional(Type.Integer({ minimum: 1, description: "A Version's number; the current one when left out." })),
          }),
          response: { 200: Artifact, 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const caller = await requireCaller(context, request);
        const artifact = await findArtifact(db, caller, request.params.artifactId, request.query.version);
        if (!artifact) throw artifactNotFound();
        return artifact;
      },
    );

    app.get(
      "/api/artifacts/:artifactId/comments",
      {
        schema: {
          tags,
          summary: "An Artifact's Comments",
          description:
            "Oldest first. A reply names the Comment it answers. They show on the Tickets linking the Artifact too.",
          params: ArtifactParams,
          response: { 200: Type.Array(Comment), 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => commentsOnArtifact(db, await requireCaller(context, request), request.params.artifactId),
    );

    app.post(
      "/api/artifacts/:artifactId/comments",
      {
        schema: {
          tags,
          summary: "Comment on an Artifact, or reply to one of its Comments",
          description:
            "Users and Agents with a full token may comment on an Artifact they can change, as on a Ticket. The " +
            "Comment also shows on the Tickets linking the Artifact; nobody is notified of it. An Agent's Comment answers " +
            "with `avoidedWords`: the words the glossary avoids that its body uses.",
          params: ArtifactParams,
          body: Type.Object({
            body: Type.String({ minLength: 1, maxLength: 100_000, pattern: "\\S", description: "Markdown." }),
            replyToId: Type.Optional(Type.String({ description: "The Comment on this Artifact being replied to." })),
          }),
          response: { 201: withAvoidedWords(Comment), 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
        },
      },
      async (request, reply) => {
        const caller = await requireCaller(context, request);
        const comment = await addArtifactComment(context, caller, request.params.artifactId, request.body);
        const place = await placeOfComment(db, comment);
        return reply.code(201).send(await warnAgent(db, caller, place, { markdown: [request.body.body] }, comment));
      },
    );

    app.get(
      "/api/artifacts/:artifactId/versions",
      {
        schema: {
          tags,
          summary: "An Artifact's Versions, oldest first",
          description: "Each Version's number, with the Actor who saved it and when, without its files.",
          params: ArtifactParams,
          response: { 200: Type.Array(ArtifactVersion), 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => artifactVersionsOf(db, await requireCaller(context, request), request.params.artifactId),
    );

    app.get(
      "/api/artifacts/:artifactId/versions/compare",
      {
        schema: {
          tags,
          summary: "Compare two of an Artifact's Versions",
          description:
            "Both Versions, and each file that differs between them, by path: added, removed or changed, with its " +
            "text compared line by line from `from` to `to`. Files that didn't change are left out. A deleted Version " +
            "answers `version_deleted`.",
          params: ArtifactParams,
          querystring: Type.Object({ from: Type.Integer({ minimum: 1 }), to: Type.Integer({ minimum: 1 }) }),
          response: { 200: ArtifactComparison, 400: ErrorBody, 401: ErrorBody, 404: ErrorBody, 410: ErrorBody },
        },
      },
      async (request) =>
        compareArtifactVersions(context, await requireCaller(context, request), request.params.artifactId, request.query),
    );

    const VersionParams = Type.Object({ artifactId: Type.String(), number: Type.Integer({ minimum: 1 }) });

    app.get(
      "/api/artifacts/:artifactId/versions/:number",
      {
        schema: {
          tags,
          summary: "One of an Artifact's Versions",
          description:
            "The Version by its number: who saved it and when, its title, page and files, without their bytes, and " +
            "the address its page is served at. A Version a User deleted answers 410 `version_deleted`, since its " +
            "number is never used again; a number the Artifact never had answers `not_found`.",
          params: VersionParams,
          response: { 200: ArtifactVersionRead, 400: ErrorBody, 401: ErrorBody, 404: ErrorBody, 410: ErrorBody },
        },
      },
      async (request) =>
        readArtifactVersion(db, await requireCaller(context, request), request.params.artifactId, request.params.number),
    );

    app.delete(
      "/api/artifacts/:artifactId/versions/:number",
      {
        schema: {
          tags,
          summary: "Delete one of an Artifact's Versions",
          description:
            "Deletes the Version and its files, which are no longer served, keeping the Artifact's other Versions; " +
            "its files' bytes are kept while another Version shares them. Deleting the current Version makes the " +
            "newest remaining one current. Its number is never used again: reading it answers `version_deleted`, " +
            "and a save based on it is refused as `outdated_version`. The only Version is refused with " +
            "`only_version`: delete the Artifact instead. Only a User may; Agents are refused with " +
            "`agent_not_allowed`.",
          params: VersionParams,
          response: { 204: Type.Null(), 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody, 410: ErrorBody },
        },
      },
      async (request, reply) => {
        const caller = await requireCaller(context, request);
        await deleteArtifactVersion(context, caller, request.params.artifactId, request.params.number);
        return reply.code(204).send(null);
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
            "were. An Agent's save answers with `avoidedWords`: the words the glossary avoids that the title and " +
            "description it gives use.",
          params: ArtifactParams,
          body: ArtifactSave,
          response: {
            200: withAvoidedWords(Artifact),
            400: ErrorBody,
            401: ErrorBody,
            403: ErrorBody,
            404: ErrorBody,
            409: OutdatedVersionBody("Artifact", ArtifactVersion),
            413: ErrorBody,
          },
        },
      },
      async (request) => {
        const caller = await requireCaller(context, request);
        const saved = await saveArtifact(context, caller, request.params.artifactId, request.body);
        const texts = given({ plain: [request.body.title], markdown: [request.body.description] });
        return warnAgent(db, caller, saved, texts, saved);
      },
    );

    app.delete(
      "/api/artifacts/:artifactId",
      {
        schema: {
          tags,
          summary: "Delete an Artifact",
          description:
            "Deletes the Artifact with all its Versions and their files, which are no longer served; it drops out of " +
            "the Tickets linking it. Only a User may; Agents are refused with `agent_not_allowed`.",
          params: ArtifactParams,
          response: { 204: Type.Null(), 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
        },
      },
      async (request, reply) => {
        await deleteArtifact(context, await requireCaller(context, request), request.params.artifactId);
        return reply.code(204).send(null);
      },
    );

    const TicketParams = Type.Object({ ticketId: Type.String() });

    app.get(
      "/api/tickets/:ticketId/artifacts",
      {
        schema: {
          tags: ["Tickets"],
          summary: "A Ticket's Linked Artifacts",
          description: "Artifacts of the Ticket's Project or of the Workspace linked to it, oldest link first.",
          params: TicketParams,
          response: { 200: Type.Array(LinkedArtifact), 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => linkedArtifactsOf(db, await requireCaller(context, request), request.params.ticketId),
    );

    app.post(
      "/api/tickets/:ticketId/artifacts",
      {
        schema: {
          tags: ["Tickets"],
          summary: "Link an Artifact to a Ticket",
          description:
            "Links an Artifact of the Ticket's Project or of the Workspace (`artifact_outside_project` for another " +
            "Project's; `unknown_artifact` for one not in the Workspace), once (`artifact_already_linked`). An Agent " +
            "links only during its own running Run on the Ticket, or on a Discovered Ticket it filed that still waits " +
            "for a User (`no_running_run`; `not_your_discovered_ticket` for another Agent's or a settled one). A " +
            "deleted Artifact drops out of its links.",
          params: TicketParams,
          body: ArtifactLink,
          response: { 201: LinkedArtifact, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request, reply) => {
        const caller = await requireCaller(context, request);
        const linked = await linkArtifact(context, caller, request.params.ticketId, request.body.artifactId);
        return reply.code(201).send(linked);
      },
    );

    app.delete(
      "/api/tickets/:ticketId/artifacts/:artifactId",
      {
        schema: {
          tags: ["Tickets"],
          summary: "Unlink an Artifact from a Ticket",
          description:
            "The Artifact stays in its Project or the Workspace; an Artifact the Ticket doesn't link answers " +
            "`not_found`. An Agent unlinks only during its own running Run on the Ticket, or on a Discovered Ticket " +
            "it filed that still waits for a User (`no_running_run`; `not_your_discovered_ticket` for another Agent's " +
            "or a settled one).",
          params: Type.Object({ ticketId: Type.String(), artifactId: Type.String() }),
          response: { 204: Type.Null(), 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
        },
      },
      async (request, reply) => {
        const caller = await requireCaller(context, request);
        await unlinkArtifact(context, caller, request.params.ticketId, request.params.artifactId);
        return reply.code(204).send(null);
      },
    );
  };
}
