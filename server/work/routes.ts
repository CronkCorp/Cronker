import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { ApiError, ErrorBody } from "../http/errors.js";
import { requireUser } from "../identity/sign-ins.js";
import { findWorkspace, type Workspace } from "../workspaces/workspaces.js";
import { createProject, findProject, projectNotFound, Project, projectsOf, ProjectSummary, StatusKind } from "./projects.js";
import { changeStatuses } from "./statuses.js";

const StatusName = Type.String({ minLength: 1, maxLength: 100, pattern: "\\S" });
const Position = Type.Integer({ minimum: 0, description: "Place on the board, counting from 0." });
const StatusParams = Type.Object({ projectId: Type.String(), statusId: Type.String() });
const statusRefusals = { 400: ErrorBody, 401: ErrorBody, 404: ErrorBody, 409: ErrorBody };
const kindRule = "Refused if it would leave any Status kind without a Status.";

export function workRoutes(context: Context): FastifyPluginAsyncTypebox {
  const { db } = context;

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
        return reply.code(201).send(await createProject(context, workspace.id, request.body));
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
        if (!project) throw projectNotFound();
        return project;
      },
    );

    app.post(
      "/api/projects/:projectId/statuses",
      {
        schema: {
          tags: ["Projects"],
          summary: "Add a Status",
          description: "Adds a Status at a position on the board, or last. Returns the Project.",
          params: Type.Object({ projectId: Type.String() }),
          body: Type.Object({ name: StatusName, kind: StatusKind, position: Type.Optional(Position) }),
          response: { 201: Project, ...statusRefusals },
        },
      },
      async (request, reply) => {
        const user = await requireUser(context, request);
        const project = await changeStatuses(context, user.id, request.params.projectId, {
          type: "add",
          ...request.body,
        });
        return reply.code(201).send(project);
      },
    );

    app.patch(
      "/api/projects/:projectId/statuses/:statusId",
      {
        schema: {
          tags: ["Projects"],
          summary: "Rename, move or change the kind of a Status",
          description: `Changes whichever of name, kind and position are given. ${kindRule} Returns the Project.`,
          params: StatusParams,
          body: Type.Object({
            name: Type.Optional(StatusName),
            kind: Type.Optional(StatusKind),
            position: Type.Optional(Position),
          }),
          response: { 200: Project, ...statusRefusals },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        const { projectId, statusId } = request.params;
        return changeStatuses(context, user.id, projectId, { type: "edit", statusId, ...request.body });
      },
    );

    app.delete(
      "/api/projects/:projectId/statuses/:statusId",
      {
        schema: {
          tags: ["Projects"],
          summary: "Remove a Status",
          description: `${kindRule} Returns the Project.`,
          params: StatusParams,
          response: { 200: Project, ...statusRefusals },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        const { projectId, statusId } = request.params;
        return changeStatuses(context, user.id, projectId, { type: "remove", statusId });
      },
    );
  };
}
