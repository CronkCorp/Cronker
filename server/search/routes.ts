import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { ApiError, ErrorBody } from "../http/errors.js";
import { requireCaller } from "../identity/callers.js";
import { findWorkspace } from "../workspaces/workspaces.js";
import { findProject, projectNotFound } from "../work/projects.js";
import { perKind, search, searchKinds, SearchResult, type SearchKind } from "./search.js";
import { candidatesPerKind, draftMentions, KeyMention, MentionCandidate, mentionCandidates, type DraftPlace } from "../work/draft-mentions.js";
import type { Caller } from "../identity/callers.js";

const kindList = `(${searchKinds.join("|")})`;

const placeProject = Type.Optional(
  Type.String({
    description: "The Project the text is written in, whose glossary it takes; the Workspace's own text when left out.",
  }),
);

export function searchRoutes(context: Context): FastifyPluginAsyncTypebox {
  const { db } = context;

  /** Where a draft is written: the Workspace, and the Project named, which must be one of it. */
  const draftPlace = async (caller: Caller, workspaceId: string, projectId: string | undefined): Promise<DraftPlace> => {
    const workspace = await findWorkspace(db, caller, workspaceId);
    if (!workspace) throw new ApiError(404, "not_found", "No such Workspace.");
    if (projectId === undefined) return { workspaceId: workspace.id, projectId: null };
    const found = await findProject(db, caller, projectId);
    if (!found || found.workspaceId !== workspace.id) throw projectNotFound();
    return { workspaceId: workspace.id, projectId: found.id };
  };

  return async (app) => {
    app.post(
      "/api/workspaces/:workspaceId/mentions",
      {
        schema: {
          tags: ["Search"],
          summary: "Find the Mentions of a draft",
          description:
            "What Markdown not yet saved mentions, as it would once saved in its place: the Ticket and Decision keys " +
            "and the Term names of its place's glossary, outside code and links, each once, keys first in order of " +
            "first mention; only what the caller can read. The web client's editor links these while a text is written.",
          params: Type.Object({ workspaceId: Type.String() }),
          body: Type.Object({ markdown: Type.String({ maxLength: 500000 }), project: placeProject }),
          response: { 200: Type.Array(KeyMention), 400: ErrorBody, 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const caller = await requireCaller(context, request);
        const place = await draftPlace(caller, request.params.workspaceId, request.body.project);
        return draftMentions(db, caller, place, request.body.markdown);
      },
    );

    app.get(
      "/api/workspaces/:workspaceId/mention-candidates",
      {
        schema: {
          tags: ["Search"],
          summary: "Offer Mentions for a word being typed",
          description:
            "What the editor's Mention picker offers for the word typed before the cursor, among what the caller can " +
            `read, at most ${candidatesPerKind} of each kind: for a Project's key and a hyphen (\`WEB-\`, \`WEB-4\`), ` +
            "its Tickets by number, the exact one first, and with no number its Decisions too; for `WEB-D3`, its " +
            "Decisions; for `D3`, the Workspace's own Decisions; for a Project's key alone in capitals, its Tickets and " +
            "Decisions; and for two or more characters starting a Term's name of the place's glossary, with its " +
            "capitalisation, those Terms. Picking one inserts its `text`, plain.",
          params: Type.Object({ workspaceId: Type.String() }),
          querystring: Type.Object({ q: Type.String({ maxLength: 200 }), project: placeProject }),
          response: { 200: Type.Array(MentionCandidate), 400: ErrorBody, 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const caller = await requireCaller(context, request);
        const place = await draftPlace(caller, request.params.workspaceId, request.query.project);
        return mentionCandidates(db, caller, place, request.query.q);
      },
    );

    app.get(
      "/api/workspaces/:workspaceId/search",
      {
        schema: {
          tags: ["Search"],
          summary: "Search the Workspace",
          description:
            `Tickets, knowledge and Transcripts of the Workspace matching \`q\`, best first with Transcripts last, ` +
            `at most ${perKind} of each kind, leaving out whatever the caller can't read, an archived Project's unless \`project\` names it, and archived Tickets unless \`includeArchived\` asks for them. A Transcript matches by an entry whose text has the whole search. ` +
            "Words match by their stem in English " +
            "(\"merging\" finds \"merged\"), written in web-search syntax.",
          params: Type.Object({ workspaceId: Type.String() }),
          querystring: Type.Object({
            q: Type.String({ maxLength: 1000, description: "Words, `\"a phrase\"`, `or` between alternatives, `-word` to leave out." }),
            project: Type.Optional(
              Type.String({
                description:
                  "A Project of the Workspace: only its own Tickets and knowledge and the Transcripts of Runs on its " +
                  "Tickets, not the Workspace's.",
              }),
            ),
            kinds: Type.Optional(
              Type.String({
                pattern: `^${kindList}(,${kindList})*$`,
                description: `Only these kinds, comma-separated: ${searchKinds.map((k) => `\`${k}\``).join(", ")}.`,
              }),
            ),
            includeArchived: Type.Optional(
              Type.Boolean({ description: "Finds archived Tickets too, each marked `archived`; left out by default." }),
            ),
          }),
          response: { 200: Type.Array(SearchResult), 400: ErrorBody, 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const caller = await requireCaller(context, request);
        const workspace = await findWorkspace(db, caller, request.params.workspaceId);
        if (!workspace) throw new ApiError(404, "not_found", "No such Workspace.");
        const { q, project: projectId, kinds, includeArchived } = request.query;
        let project: string | null = null;
        if (projectId !== undefined) {
          const found = await findProject(db, caller, projectId);
          if (!found || found.workspaceId !== workspace.id) throw projectNotFound();
          project = found.id;
        }
        return search(db, caller, workspace.id, {
          q,
          project,
          kinds: kinds === undefined ? [...searchKinds] : (kinds.split(",") as SearchKind[]),
          includeArchived,
        });
      },
    );
  };
}
