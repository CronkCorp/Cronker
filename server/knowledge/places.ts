import type { FastifyRequest } from "fastify";
import { Type } from "typebox";
import type { Db } from "../db.js";
import { ApiError } from "../http/errors.js";
import type { Caller } from "../identity/callers.js";
import { findWorkspace } from "../workspaces/workspaces.js";
import { findProject, projectNotFound } from "../work/projects.js";

/** Where knowledge is kept: a Project, or the Workspace when `projectId` is null. */
export interface Place {
  workspaceId: string;
  projectId: string | null;
}

/**
 * Where knowledge is kept: a Project, or the Workspace beneath its Projects. Each is reached from its own path, and
 * `find` resolves the request's Project or Workspace in the caller's view, or answers not found.
 */
export function knowledgePlaces(db: Db) {
  return [
    {
      path: "/api/projects/:projectId",
      params: Type.Object({ projectId: Type.String() }),
      name: "a Project's",
      async find(request: FastifyRequest, caller: Caller): Promise<Place> {
        const project = await findProject(db, caller, (request.params as { projectId: string }).projectId);
        if (!project) throw projectNotFound();
        return { workspaceId: project.workspaceId, projectId: project.id };
      },
    },
    {
      path: "/api/workspaces/:workspaceId",
      params: Type.Object({ workspaceId: Type.String() }),
      name: "the Workspace's",
      async find(request: FastifyRequest, caller: Caller): Promise<Place> {
        const workspace = await findWorkspace(db, caller, (request.params as { workspaceId: string }).workspaceId);
        if (!workspace) throw new ApiError(404, "not_found", "No such Workspace.");
        return { workspaceId: workspace.id, projectId: null };
      },
    },
  ];
}
