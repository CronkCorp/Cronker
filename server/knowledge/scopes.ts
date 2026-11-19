import type { FastifyRequest } from "fastify";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { ApiError } from "../http/errors.js";
import type { Caller } from "../identity/callers.js";
import { findWorkspace } from "../workspaces/workspaces.js";
import { findProject, projectNotFound } from "../work/projects.js";

/** Whose knowledge: a Project's, or the Workspace's own when `projectId` is null. */
export interface Scope {
  workspaceId: string;
  projectId: string | null;
}

/**
 * The two places knowledge lives, each reached from its own path under `/api`: a Project's and the Workspace's.
 * `find` answers the scope the request names, if the caller sees it.
 */
export function scopes({ db }: Context, path: string) {
  return [
    {
      path: `/api/projects/:projectId/${path}`,
      params: Type.Object({ projectId: Type.String() }),
      name: "a Project's",
      async find(request: FastifyRequest, caller: Caller): Promise<Scope> {
        const project = await findProject(db, caller, (request.params as { projectId: string }).projectId);
        if (!project) throw projectNotFound();
        return { workspaceId: project.workspaceId, projectId: project.id };
      },
    },
    {
      path: `/api/workspaces/:workspaceId/${path}`,
      params: Type.Object({ workspaceId: Type.String() }),
      name: "the Workspace's",
      async find(request: FastifyRequest, caller: Caller): Promise<Scope> {
        const workspace = await findWorkspace(db, caller, (request.params as { workspaceId: string }).workspaceId);
        if (!workspace) throw new ApiError(404, "not_found", "No such Workspace.");
        return { workspaceId: workspace.id, projectId: null };
      },
    },
  ];
}
