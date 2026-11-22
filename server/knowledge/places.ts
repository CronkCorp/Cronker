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

/** Where a Ticket's texts are kept: its Project. */
export async function placeOfTicket(db: Db, ticketId: string): Promise<Place> {
  const { rows } = await db.query<Place>(
    `select workspace_id as "workspaceId", project_id as "projectId" from tickets where id = $1`,
    [ticketId],
  );
  return rows[0]!;
}

/** Where a Comment is kept: its Ticket's Project, or its Artifact's Project or Workspace. */
export async function placeOfComment(db: Db, comment: { ticketId: string | null; artifactId: string | null }): Promise<Place> {
  if (comment.ticketId !== null) return placeOfTicket(db, comment.ticketId);
  const { rows } = await db.query<Place>(
    `select workspace_id as "workspaceId", project_id as "projectId" from artifacts where id = $1`,
    [comment.artifactId],
  );
  return rows[0]!;
}

/** A Place with what Users call it: the Project's key, or the Workspace's name. */
export interface NamedPlace extends Place {
  label: string;
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
      async find(request: FastifyRequest, caller: Caller): Promise<NamedPlace> {
        const project = await findProject(db, caller, (request.params as { projectId: string }).projectId);
        if (!project) throw projectNotFound();
        return { workspaceId: project.workspaceId, projectId: project.id, label: project.key };
      },
    },
    {
      path: "/api/workspaces/:workspaceId",
      params: Type.Object({ workspaceId: Type.String() }),
      name: "the Workspace's",
      async find(request: FastifyRequest, caller: Caller): Promise<NamedPlace> {
        const workspace = await findWorkspace(db, caller, (request.params as { workspaceId: string }).workspaceId);
        if (!workspace) throw new ApiError(404, "not_found", "No such Workspace.");
        return { workspaceId: workspace.id, projectId: null, label: workspace.name };
      },
    },
  ];
}
