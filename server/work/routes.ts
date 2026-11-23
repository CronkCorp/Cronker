import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { ApiError, ErrorBody } from "../http/errors.js";
import { requireUser } from "../identity/sign-ins.js";
import { requireCaller } from "../identity/callers.js";
import { requireOwnerCaller } from "../identity/acts.js";
import { findWorkspace, type Workspace } from "../workspaces/workspaces.js";
import {
  createProject,
  editProject,
  findProject,
  Project,
  ProjectCreate,
  ProjectEdit,
  projectNotFound,
  projectsOf,
  ProjectSummary,
} from "./projects.js";
import { requireProjectCreator } from "./board-rights.js";
import { changeStatuses, StatusAdd, StatusEdit } from "./statuses.js";
import { changeStep } from "./step-changes.js";
import {
  createRelease,
  cutRelease,
  deleteRelease,
  OpenReleaseTicket,
  publishRelease,
  Release,
  ReleaseCreate,
  ReleaseEdit,
  ReleasePublish,
  releasesOf,
  renameRelease,
} from "./releases.js";
import { defaultRoundLimit, StepPut } from "./steps.js";

const ReleaseParams = Type.Object({ projectId: Type.String(), releaseId: Type.String() });
const releaseRule =
  "Needs Write in the Project. Only a planned Release is renamed, deleted or cut (`release_not_planned`). A name is a " +
  "semantic version such as `v0.3.0`, with or without a leading `v` (`invalid_release_name`), unique in the Project " +
  "ignoring case (`release_name_taken`).";
const StatusParams = Type.Object({ projectId: Type.String(), statusId: Type.String() });
const statusRefusals = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };
const kindRule = "Refused if it would leave any Status kind without a Status.";
const writeRule = "Needs Write in the Project, for Users and Agents alike.";
const stepAuthorRule =
  "Needs Write in the Project, and an Agent also needs its Owner to be an Admin of the Workspace, since the Brief, " +
  "model and Outcomes are what later Runs work by.";
const outcomeRules =
  "Exactly one Outcome is the default and exactly one, another, is *needs you*; neither may target a Done or " +
  "Canceled Status, and no Outcome may target a Canceled Status. The *needs you* Outcome may not target the Status " +
  "the Step is on either.";
export function workRoutes(context: Context): FastifyPluginAsyncTypebox {
  const { db } = context;

  /** The Workspace, if in view; `agents` lets Agents ask, for what they may do as well as Users. */
  async function requireWorkspace(request: FastifyRequest, workspaceId: string, { agents = false } = {}): Promise<Workspace> {
    const viewer = agents ? await requireCaller(context, request) : { kind: "user" as const, ...(await requireUser(context, request)) };
    const workspace = await findWorkspace(db, viewer, workspaceId);
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
        const workspace = await requireWorkspace(request, request.params.workspaceId, { agents: true });
        return projectsOf(db, await requireCaller(context, request), workspace.id);
      },
    );

    app.post(
      "/api/workspaces/:workspaceId/projects",
      {
        schema: {
          tags: ["Projects"],
          summary: "Create a Project",
          description:
            "Creates a Project with the default board's Statuses and Steps. Users and Agents alike; an Agent needs a " +
            "token that isn't read-only and its Owner to be an Admin of the Workspace, since the default Steps are " +
            "what later Runs work by.",
          params: Type.Object({ workspaceId: Type.String() }),
          body: ProjectCreate,
          response: { 201: Project, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request, reply) => {
        const workspace = await requireWorkspace(request, request.params.workspaceId, { agents: true });
        await requireProjectCreator(db, await requireCaller(context, request), workspace.id);
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
        const caller = await requireCaller(context, request);
        const project = await findProject(db, caller, request.params.projectId);
        if (!project) throw projectNotFound();
        return project;
      },
    );

    app.patch(
      "/api/projects/:projectId",
      {
        schema: {
          tags: ["Projects"],
          summary: "Change a Project's settings",
          params: Type.Object({ projectId: Type.String() }),
          body: ProjectEdit,
          response: { 200: Project, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        return editProject(context, user.id, request.params.projectId, request.body);
      },
    );

    app.get(
      "/api/projects/:projectId/releases",
      {
        schema: {
          tags: ["Releases"],
          summary: "The Project's Releases",
          description: "Each with its state, release branch, open and done counts and Tickets; newest first.",
          params: Type.Object({ projectId: Type.String() }),
          response: { 200: Type.Array(Release), 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => releasesOf(db, await requireCaller(context, request), request.params.projectId),
    );

    app.post(
      "/api/projects/:projectId/releases",
      {
        schema: {
          tags: ["Releases"],
          summary: "Create a Release",
          description: `Creates a planned Release. ${releaseRule}`,
          params: Type.Object({ projectId: Type.String() }),
          body: ReleaseCreate,
          response: { 201: Release, ...statusRefusals },
        },
      },
      async (request, reply) => {
        const caller = await requireCaller(context, request);
        return reply.code(201).send(await createRelease(context, caller, request.params.projectId, request.body));
      },
    );

    app.patch(
      "/api/projects/:projectId/releases/:releaseId",
      {
        schema: {
          tags: ["Releases"],
          summary: "Rename a Release",
          description: `Renames a planned Release; its Tickets stay tagged with it. ${releaseRule}`,
          params: ReleaseParams,
          body: ReleaseEdit,
          response: { 200: Release, ...statusRefusals },
        },
      },
      async (request) => {
        const caller = await requireCaller(context, request);
        const { projectId, releaseId } = request.params;
        return renameRelease(context, caller, projectId, releaseId, request.body);
      },
    );

    app.delete(
      "/api/projects/:projectId/releases/:releaseId",
      {
        schema: {
          tags: ["Releases"],
          summary: "Delete a Release",
          description: `Deletes a planned Release, untagging its Tickets, each recording the Change. ${releaseRule}`,
          params: ReleaseParams,
          response: { 204: Type.Null(), ...statusRefusals },
        },
      },
      async (request, reply) => {
        const caller = await requireCaller(context, request);
        const { projectId, releaseId } = request.params;
        await deleteRelease(context, caller, projectId, releaseId);
        return reply.code(204).send(null);
      },
    );

    app.post(
      "/api/projects/:projectId/releases/:releaseId/cut",
      {
        schema: {
          tags: ["Releases"],
          summary: "Cut a Release",
          description:
            "Creates `release/<name>` at the default branch's head in each Repository the Project lists, as the GitHub " +
            "App, and makes the Release cut, recording each Repository's commit and who cut it. Only a User with Write, " +
            "or an Agent with a Full token and Write, cuts (`full_token_needed` for a Write token), and only a planned Release (`release_not_planned`). Every Repository is checked first: a Project " +
            "listing none (`no_repositories`), a Repository the App can't reach (`repository_not_installed`) or a " +
            "release branch that already exists in any of them (`release_branch_exists`) refuses the whole Cut before " +
            "anything is created.",
          params: ReleaseParams,
          response: { 200: Release, ...statusRefusals, 502: ErrorBody },
        },
      },
      async (request) => {
        const caller = await requireOwnerCaller(context, request, {
          act: "cutting a Release",
          rule: "Cutting a Release creates its release branches on GitHub, as a User's act.",
        });
        const { projectId, releaseId } = request.params;
        return cutRelease(context, caller, projectId, releaseId);
      },
    );

    app.post(
      "/api/projects/:projectId/releases/:releaseId/release",
      {
        schema: {
          tags: ["Releases"],
          summary: "Release a Release",
          description:
            "Tags each release branch's head `<name>` and creates a GitHub Release in each Repository the Release was " +
            "cut in, as the GitHub App, with notes of an Upgrade notes part (`upgradeNotes`, left out when blank) then " +
            "its Tickets by key and title, and makes the Release released, recording each tag and GitHub Release and " +
            "who released it. A released Release keeps its Tickets: tagging and untagging them is refused. Only a User " +
            "with Write, or an Agent with a Full token and Write, releases (`full_token_needed` for a Write token), and only a cut Release (`release_not_cut`). While any of its Tickets is open, it is " +
            "refused with `release_has_open_tickets`, listing them as `openTickets`, unless `confirm` is true. Every " +
            "Repository is checked first: a missing release branch (`release_branch_missing`), an existing tag " +
            "(`release_tag_exists`) or a Repository the App can't reach (`repository_not_installed`) refuses the whole " +
            "Release before anything is created.",
          params: ReleaseParams,
          body: ReleasePublish,
          response: {
            200: Release,
            ...statusRefusals,
            409: Type.Object({
              error: Type.Object({
                ...ErrorBody.properties.error.properties,
                openTickets: Type.Optional(
                  Type.Array(OpenReleaseTicket, { description: "With `release_has_open_tickets`: its open Tickets, by key." }),
                ),
              }),
            }),
            502: ErrorBody,
          },
        },
      },
      async (request) => {
        const caller = await requireOwnerCaller(context, request, {
          act: "releasing a Release",
          rule: "Releasing tags and publishes a Release on GitHub, as a User's act.",
        });
        const { projectId, releaseId } = request.params;
        return publishRelease(context, caller, projectId, releaseId, request.body);
      },
    );

    app.post(
      "/api/projects/:projectId/statuses",
      {
        schema: {
          tags: ["Projects"],
          summary: "Add a Status",
          description: `Adds a Status at a position on the board, or last. ${writeRule} Returns the Project.`,
          params: Type.Object({ projectId: Type.String() }),
          body: StatusAdd,
          response: { 201: Project, ...statusRefusals },
        },
      },
      async (request, reply) => {
        const caller = await requireCaller(context, request);
        const project = await changeStatuses(context, caller, request.params.projectId, {
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
          description:
            `Changes whichever of name, kind and position are given. ${kindRule} ` +
            "A Status with a Step can't become Done or Canceled: remove its Step first. " +
            `${writeRule} Returns the Project.`,
          params: StatusParams,
          body: StatusEdit,
          response: { 200: Project, ...statusRefusals },
        },
      },
      async (request) => {
        const caller = await requireCaller(context, request);
        const { projectId, statusId } = request.params;
        return changeStatuses(context, caller, projectId, { type: "edit", statusId, ...request.body });
      },
    );

    app.delete(
      "/api/projects/:projectId/statuses/:statusId",
      {
        schema: {
          tags: ["Projects"],
          summary: "Remove a Status",
          description:
            `${kindRule} Refused too while the Status holds Tickets, naming how many: ` +
            `move them to another Status first. ${writeRule} Returns the Project.`,
          params: StatusParams,
          response: { 200: Project, ...statusRefusals },
        },
      },
      async (request) => {
        const caller = await requireCaller(context, request);
        const { projectId, statusId } = request.params;
        return changeStatuses(context, caller, projectId, { type: "remove", statusId });
      },
    );

    app.put(
      "/api/projects/:projectId/statuses/:statusId/step",
      {
        schema: {
          tags: ["Projects"],
          summary: "Attach or edit a Status's Step",
          description:
            "Gives the Status this Step, replacing any it had: Tickets entering it get Runs. " +
            "Refused on a Done or Canceled Status, where Tickets get no Runs. " +
            `${outcomeRules} ${stepAuthorRule} Returns the Project.`,
          params: StatusParams,
          body: StepPut,
          response: { 200: Project, ...statusRefusals },
        },
      },
      async (request) => {
        const caller = await requireCaller(context, request);
        const { projectId, statusId } = request.params;
        const { kind = "ordinary", roundLimit = defaultRoundLimit, labelRule = null, ...step } = request.body;
        return changeStep(context, caller, projectId, statusId, { type: "put", step: { ...step, kind, roundLimit, labelRule } });
      },
    );

    app.delete(
      "/api/projects/:projectId/statuses/:statusId/step",
      {
        schema: {
          tags: ["Projects"],
          summary: "Remove a Status's Step",
          description: `Takes the Step off the Status, so Tickets in it wait for a User. ${writeRule} Returns the Project.`,
          params: StatusParams,
          response: { 200: Project, ...statusRefusals },
        },
      },
      async (request) => {
        const caller = await requireCaller(context, request);
        const { projectId, statusId } = request.params;
        return changeStep(context, caller, projectId, statusId, { type: "remove" });
      },
    );
  };
}
