import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { ApiError, ErrorBody } from "../http/errors.js";
import { requireUser } from "../identity/sign-ins.js";
import { findWorkspace, type Workspace } from "../workspaces/workspaces.js";
import { createProject, findProject, notFound, Project, projectsOf, ProjectSummary } from "./projects.js";

export function workRoutes(context: Context): FastifyPluginAsyncTypebox {
  const { db, clock } = context;

  async function requireWorkspace(request: FastifyRequest, workspaceId: string): Promise<Workspace> {
    const user = await requireUser(context, request);
    const workspace = await findWorkspace(db, user.id, workspaceId);
    if (!workspace) throw new ApiError(404, "not_found", "No such Workspace.");
    return workspace;
  }

  return async (app) => {
    app.get(
      "/api/workspaces/:workspaceId/projects",
      {
        schema: {
          tags: ["Projects"],
          summary: "The Workspace's Projects",
          params: Type.Object({ workspaceId: Type.String() }),
          response: { 200: Type.Array(ProjectSummary), 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const workspace = await requireWorkspace(request, request.params.workspaceId);
        return projectsOf(db, workspace.id);
      },
    );

    app.post(
      "/api/workspaces/:workspaceId/projects",
      {
        schema: {
          tags: ["Projects"],
          summary: "Create a Project",
          description: "Creates a Project with the default board's Statuses.",
          params: Type.Object({ workspaceId: Type.String() }),
          body: Type.Object({
            name: Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" }),
            key: Type.String({
              pattern: "^[A-Za-z][A-Za-z0-9]{1,9}$",
              description: "2 to 10 letters and digits, starting with a letter; kept in capitals.",
            }),
          }),
          response: { 201: Project, 401: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request, reply) => {
        const workspace = await requireWorkspace(request, request.params.workspaceId);
        return reply.code(201).send(await createProject(db, clock, workspace.id, request.body));
      },
    );

    app.get(
      "/api/projects/:projectId",
      {
        schema: {
          tags: ["Projects"],
          summary: "A Project with its Statuses in board order",
          params: Type.Object({ projectId: Type.String() }),
          response: { 200: Project, 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        const project = await findProject(db, user.id, request.params.projectId);
        if (!project) throw notFound();
        return project;
      },
    );
  };
}
