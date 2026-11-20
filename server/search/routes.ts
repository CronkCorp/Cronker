import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { ApiError, ErrorBody } from "../http/errors.js";
import { requireCaller } from "../identity/callers.js";
import { findWorkspace } from "../workspaces/workspaces.js";
import { findProject, projectNotFound } from "../work/projects.js";
import { search, searchKinds, SearchResult, type SearchKind } from "./search.js";

const kindList = `(${searchKinds.join("|")})`;

export function searchRoutes(context: Context): FastifyPluginAsyncTypebox {
  const { db } = context;
  return async (app) => {
    app.get(
      "/api/workspaces/:workspaceId/search",
      {
        schema: {
          tags: ["Search"],
          summary: "Search the Workspace",
          description:
            "Tickets and knowledge of the Workspace matching `q`, best first. Words match by their stem in English " +
            "(\"merging\" finds \"merged\"), written in web-search syntax.",
          params: Type.Object({ workspaceId: Type.String() }),
          querystring: Type.Object({
            q: Type.String({ maxLength: 1000, description: "Words, `\"a phrase\"`, `or` between alternatives, `-word` to leave out." }),
            project: Type.Optional(
              Type.String({ description: "A Project of the Workspace: only its own Tickets and knowledge, not the Workspace's." }),
            ),
            kinds: Type.Optional(
              Type.String({
                pattern: `^${kindList}(,${kindList})*$`,
                description: `Only these kinds, comma-separated: ${searchKinds.map((k) => `\`${k}\``).join(", ")}.`,
              }),
            ),
          }),
          response: { 200: Type.Array(SearchResult), 400: ErrorBody, 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const caller = await requireCaller(context, request);
        const workspace = await findWorkspace(db, caller, request.params.workspaceId);
        if (!workspace) throw new ApiError(404, "not_found", "No such Workspace.");
        const { q, project: projectId, kinds } = request.query;
        let project: string | null = null;
        if (projectId !== undefined) {
          const found = await findProject(db, caller, projectId);
          if (!found || found.workspaceId !== workspace.id) throw projectNotFound();
          project = found.id;
        }
        return search(db, workspace.id, {
          q,
          project,
          kinds: kinds === undefined ? [...searchKinds] : (kinds.split(",") as SearchKind[]),
        });
      },
    );
  };
}
