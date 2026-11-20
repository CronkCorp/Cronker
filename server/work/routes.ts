import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { ApiError, ErrorBody } from "../http/errors.js";
import { requireUser } from "../identity/sign-ins.js";
import { requireCaller } from "../identity/callers.js";
import { findWorkspace, type Workspace } from "../workspaces/workspaces.js";
import { createProject, editProject, findProject, projectNotFound, Project, projectsOf, ProjectSummary, StatusKind } from "./projects.js";
import { changeStatuses } from "./statuses.js";
import { changeStep } from "./step-changes.js";
import { defaultRoundLimit, LabelRule, Outcome, stepKindDescription } from "./steps.js";

const StatusName = Type.String({ minLength: 1, maxLength: 100, pattern: "\\S" });
const Position = Type.Integer({ minimum: 0, description: "Place on the board, counting from 0." });
const StatusParams = Type.Object({ projectId: Type.String(), statusId: Type.String() });
const statusRefusals = { 400: ErrorBody, 401: ErrorBody, 404: ErrorBody, 409: ErrorBody };
const kindRule = "Refused if it would leave any Status kind without a Status.";
const outcomeRules =
  "Exactly one Outcome is the default and exactly one, another, is *needs you*; neither may target a Done or " +
  "Canceled Status, and no Outcome may target a Canceled Status. The *needs you* Outcome may not target the Status " +
  "the Step is on either.";
const StepBody = Type.Object({
  kind: Type.Optional(
    Type.Union([Type.Literal("ordinary"), Type.Literal("merge")], {
      default: "ordinary",
      description: `${stepKindDescription} Ordinary unless given.`,
    }),
  ),
  brief: Type.String({ minLength: 1, maxLength: 50_000, pattern: "\\S", description: "Markdown." }),
  model: Type.String({
    minLength: 1,
    maxLength: 50,
    pattern: "^\\S+$",
    description: "The label of the model the Step wants, such as `haiku`, `sonnet` or `opus`.",
  }),
  roundLimit: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 100,
      default: defaultRoundLimit,
      description: "How many rounds an Outcome that counts as one may send the Ticket on before it goes to *needs you*.",
    }),
  ),
  labelRule: Type.Optional(
    Type.Union([LabelRule, Type.Null()], {
      default: null,
      description:
        "Which Tickets the Step lets through; none by default, letting every Ticket through. A Ticket that doesn't pass " +
        "gets no Run and moves on by the default Outcome.",
    }),
  ),
  outcomes: Type.Array(Outcome, { minItems: 2, maxItems: 20 }),
});

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
          body: Type.Object({
            newTicketsDelegated: Type.Optional(
              Type.Boolean({ description: "Whether new Tickets start delegated to their creator's first Agent." }),
            ),
            autonomousDelegationDefault: Type.Optional(
              Type.Boolean({
                description:
                  "Whether a Ticket takes Autonomous Delegation when first delegated, unless a User set it on the Ticket already.",
              }),
            ),
            pullRequestAutomation: Type.Optional(
              Type.Boolean({
                description: "Whether a merged Pull Request completes the Tickets it links in this Project; off, merges only update its state.",
              }),
            ),
            agentsMayMerge: Type.Optional(
              Type.Boolean({
                description:
                  "Whether a Merge Step lets agents merge the Pull Requests of Tickets with Autonomous Delegation. Only an Admin " +
                  "may give it, whatever its value.",
              }),
            ),
          }),
          response: { 200: Project, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        return editProject(context, user.id, request.params.projectId, request.body);
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
          description:
            `Changes whichever of name, kind and position are given. ${kindRule} ` +
            "A Status with a Step can't become Done or Canceled: remove its Step first. Returns the Project.",
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
          description:
            `${kindRule} Refused too while the Status holds Tickets, naming how many: ` +
            "move them to another Status first. Returns the Project.",
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

    app.put(
      "/api/projects/:projectId/statuses/:statusId/step",
      {
        schema: {
          tags: ["Projects"],
          summary: "Attach or edit a Status's Step",
          description:
            "Gives the Status this Step, replacing any it had: Tickets entering it get Runs. " +
            "Refused on a Done or Canceled Status, where Tickets get no Runs. " +
            `${outcomeRules} Returns the Project.`,
          params: StatusParams,
          body: StepBody,
          response: { 200: Project, ...statusRefusals },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        const { projectId, statusId } = request.params;
        const { kind = "ordinary", roundLimit = defaultRoundLimit, labelRule = null, ...step } = request.body;
        return changeStep(context, user.id, projectId, statusId, { type: "put", step: { ...step, kind, roundLimit, labelRule } });
      },
    );

    app.delete(
      "/api/projects/:projectId/statuses/:statusId/step",
      {
        schema: {
          tags: ["Projects"],
          summary: "Remove a Status's Step",
          description: "Takes the Step off the Status, so Tickets in it wait for a User. Returns the Project.",
          params: StatusParams,
          response: { 200: Project, ...statusRefusals },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        const { projectId, statusId } = request.params;
        return changeStep(context, user.id, projectId, statusId, { type: "remove" });
      },
    );
  };
}
