import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { ApiError, ErrorBody } from "../http/errors.js";
import { User } from "../identity/user.js";
import {
  AddedMember,
  cancelPendingAdd,
  addMember,
  addMemberByGitHub,
  issueResetLink,
  Member,
  membersOf,
  PendingAdd,
  pendingAddsOf,
  MemberAdd,
  MemberAddByGitHub,
  MemberEdit,
  removeMember,
  requireAdmin,
  requireMember,
  setAdmin,
} from "./members.js";
import { requireUser } from "../identity/sign-ins.js";
import { requireCaller } from "../identity/callers.js";
import {
  changeSettings,
  createWorkspace,
  findWorkspace,
  Membership,
  renameWorkspace,
  settingsOf,
  Workspace,
  WorkspaceCreate,
  WorkspaceRename,
  WorkspaceSettings,
  WorkspaceSettingsEdit,
  ModelId,
} from "./workspaces.js";
import { Link } from "../identity/links.js";
import { modelIdsOf, ModelIdSave, ModelLabel, removeModelId, saveModelId } from "./model-ids.js";

export function workspaceRoutes(context: Context): FastifyPluginAsyncTypebox {
  const { db, clock } = context;
  return async (app) => {
    app.post(
      "/api/workspaces",
      {
        schema: {
          tags: ["Workspaces"],
          summary: "Create a Workspace",
          description:
            "Any signed-in User may create a Workspace, and becomes its Admin. Its slug, the Workspace's name in web " +
            "addresses, is the one given (`workspace_slug_taken` when another Workspace has it), or else one made " +
            "from its name; it never changes.",
          body: WorkspaceCreate,
          response: { 201: Membership, 400: ErrorBody, 401: ErrorBody, 409: ErrorBody },
        },
      },
      async (request, reply) => {
        const user = await requireUser(context, request);
        return reply.code(201).send(await createWorkspace(db, clock, user.id, request.body));
      },
    );

    app.get(
      "/api/workspaces/:workspaceId",
      {
        schema: {
          tags: ["Workspaces"],
          summary: "A Workspace the signed-in User belongs to, or an Agent's own",
          params: Type.Object({ workspaceId: Type.String() }),
          response: { 200: Workspace, 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const caller = await requireCaller(context, request);
        const workspace = await findWorkspace(db, caller, request.params.workspaceId);
        if (!workspace) throw new ApiError(404, "not_found", "No such Workspace.");
        return workspace;
      },
    );

    app.patch(
      "/api/workspaces/:workspaceId",
      {
        schema: {
          tags: ["Workspaces"],
          summary: "Rename a Workspace (Admins only)",
          params: Type.Object({ workspaceId: Type.String() }),
          body: WorkspaceRename,
          response: { 200: Workspace, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        const workspace = await requireAdmin(db, user.id, request.params.workspaceId);
        return renameWorkspace(db, workspace.id, request.body.name);
      },
    );

    app.get(
      "/api/workspaces/:workspaceId/settings",
      {
        schema: {
          tags: ["Workspaces"],
          summary: "A Workspace's settings",
          params: Type.Object({ workspaceId: Type.String() }),
          response: { 200: WorkspaceSettings, 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const caller = await requireCaller(context, request);
        const workspace = await findWorkspace(db, caller, request.params.workspaceId);
        if (!workspace) throw new ApiError(404, "not_found", "No such Workspace.");
        return settingsOf(db, workspace.id);
      },
    );

    app.patch(
      "/api/workspaces/:workspaceId/settings",
      {
        schema: {
          tags: ["Workspaces"],
          summary: "Change a Workspace's settings (Admins only)",
          description: "Changes whichever settings are given, such as the lost-Run threshold.",
          params: Type.Object({ workspaceId: Type.String() }),
          body: WorkspaceSettingsEdit,
          response: { 200: WorkspaceSettings, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        const workspace = await requireAdmin(db, user.id, request.params.workspaceId);
        return changeSettings(db, workspace.id, request.body);
      },
    );

    app.get(
      "/api/workspaces/:workspaceId/model-ids",
      {
        schema: {
          tags: ["Workspaces"],
          summary: "The Workspace's model ids, for its Users and Agents",
          description:
            "The exact model id each model label stands for, so a Runner setup knows which model each routine gets. " +
            "Labels are matched ignoring case. The same list, in the same order, as the Workspace's settings' `modelIds`.",
          params: Type.Object({ workspaceId: Type.String() }),
          response: { 200: Type.Array(ModelId), 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const caller = await requireCaller(context, request);
        const workspace = await findWorkspace(db, caller, request.params.workspaceId);
        if (!workspace) throw new ApiError(404, "not_found", "No such Workspace.");
        return modelIdsOf(db, workspace.id);
      },
    );

    const ModelIdParams = Type.Object({ workspaceId: Type.String(), label: ModelLabel });

    app.put(
      "/api/workspaces/:workspaceId/model-ids/:label",
      {
        schema: {
          tags: ["Workspaces"],
          summary: "Set the model id a label stands for (Admins only)",
          description:
            "Adds the label, or changes the one matching it ignoring case, which then takes this spelling.",
          params: ModelIdParams,
          body: ModelIdSave,
          response: { 200: ModelId, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        const workspace = await requireAdmin(db, user.id, request.params.workspaceId);
        return saveModelId(db, workspace.id, request.params.label, request.body.modelId);
      },
    );

    app.delete(
      "/api/workspaces/:workspaceId/model-ids/:label",
      {
        schema: {
          tags: ["Workspaces"],
          summary: "Remove a label's model id (Admins only)",
          description: "Removes the label matching this one ignoring case.",
          params: ModelIdParams,
          response: { 204: Type.Null(), 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
        },
      },
      async (request, reply) => {
        const user = await requireUser(context, request);
        const workspace = await requireAdmin(db, user.id, request.params.workspaceId);
        await removeModelId(db, workspace.id, request.params.label);
        return reply.code(204).send(null);
      },
    );

    app.get(
      "/api/workspaces/:workspaceId/members",
      {
        schema: {
          tags: ["Workspaces"],
          summary: "The Workspace's members",
          params: Type.Object({ workspaceId: Type.String() }),
          response: { 200: Type.Array(Member), 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const caller = await requireCaller(context, request);
        const workspace = await findWorkspace(db, caller, request.params.workspaceId);
        if (!workspace) throw new ApiError(404, "not_found", "No such Workspace.");
        return membersOf(db, workspace.id);
      },
    );

    app.get(
      "/api/workspaces/:workspaceId/pending-adds",
      {
        schema: {
          tags: ["Workspaces"],
          summary: "Who an Admin added but hasn't joined yet (Admins only)",
          description:
            "Each says how they were added: by email, joining through a one-time link not used or expired yet, or by GitHub login, joining at their next sign-in with GitHub.",
          params: Type.Object({ workspaceId: Type.String() }),
          response: { 200: Type.Array(PendingAdd), 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        const workspace = await requireAdmin(db, user.id, request.params.workspaceId);
        return pendingAddsOf(context, workspace.id);
      },
    );

    app.delete(
      "/api/workspaces/:workspaceId/pending-adds/:userId",
      {
        schema: {
          tags: ["Workspaces"],
          summary: "Cancel a pending add (Admins only)",
          description:
            "Ends the User's unused links to join the Workspace and their add by GitHub login, so they can join by neither. They can be added again.",
          params: Type.Object({ workspaceId: Type.String(), userId: Type.String() }),
          response: { 204: Type.Null(), 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
        },
      },
      async (request, reply) => {
        const user = await requireUser(context, request);
        const workspace = await requireAdmin(db, user.id, request.params.workspaceId);
        await cancelPendingAdd(context, workspace.id, request.params.userId);
        return reply.code(204).send(null);
      },
    );

    app.post(
      "/api/workspaces/:workspaceId/members",
      {
        schema: {
          tags: ["Workspaces"],
          summary: "Add a User by email (Admins only)",
          description:
            "Gives a one-time link, valid 7 days, for the Admin to pass on. Using it joins the User: a new User sets their password with it, and one who can already sign in gives theirs.",
          params: Type.Object({ workspaceId: Type.String() }),
          body: MemberAdd,
          response: { 201: AddedMember, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request, reply) => {
        const user = await requireUser(context, request);
        const workspace = await requireAdmin(db, user.id, request.params.workspaceId);
        return reply.code(201).send(await addMember(context, workspace.id, request.body.email.trim()));
      },
    );

    app.post(
      "/api/workspaces/:workspaceId/members/github",
      {
        schema: {
          tags: ["Workspaces"],
          summary: "Add a User by GitHub login (Admins only)",
          description:
            "Creates a User for that GitHub account if no User has it yet. They join the Workspace at their next sign-in with GitHub. Refused with `github_not_set_up` while the installation has no GitHub App, and `unknown_github_login` if GitHub has no such account.",
          params: Type.Object({ workspaceId: Type.String() }),
          body: MemberAddByGitHub,
          response: {
            201: Type.Object({ user: User }),
            401: ErrorBody,
            403: ErrorBody,
            404: ErrorBody,
            409: ErrorBody,
            502: ErrorBody,
          },
        },
      },
      async (request, reply) => {
        const user = await requireUser(context, request);
        const workspace = await requireAdmin(db, user.id, request.params.workspaceId);
        const added = await addMemberByGitHub(context, user.id, workspace.id, request.body.login);
        return reply.code(201).send({ user: added });
      },
    );

    const MemberParams = Type.Object({ workspaceId: Type.String(), userId: Type.String() });

    app.patch(
      "/api/workspaces/:workspaceId/members/:userId",
      {
        schema: {
          tags: ["Workspaces"],
          summary: "Make a member Admin or not (Admins only)",
          description: "Refused with `last_admin` if it would leave the Workspace without an Admin.",
          params: MemberParams,
          body: MemberEdit,
          response: { 200: Member, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        const workspace = await requireAdmin(db, user.id, request.params.workspaceId);
        return setAdmin(db, workspace.id, request.params.userId, request.body.isAdmin);
      },
    );

    app.delete(
      "/api/workspaces/:workspaceId/members/:userId",
      {
        schema: {
          tags: ["Workspaces"],
          summary: "Remove a member (Admins only)",
          description:
            "The member loses access to the Workspace at once. Refused with `last_admin` if it would leave the Workspace without an Admin.",
          params: MemberParams,
          response: { 204: Type.Null(), 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request, reply) => {
        const user = await requireUser(context, request);
        const workspace = await requireAdmin(db, user.id, request.params.workspaceId);
        await removeMember(context, user.id, workspace.id, request.params.userId);
        return reply.code(204).send(null);
      },
    );

    app.post(
      "/api/workspaces/:workspaceId/members/:userId/reset-link",
      {
        schema: {
          tags: ["Workspaces"],
          summary: "Issue a password reset link for a member (Admins only)",
          description:
            "A one-time link, valid 7 days, for the Admin to pass on. Using it sets a new password and ends the member's sign-ins. Refused with `member_elsewhere` if the member also belongs to a Workspace the Admin isn't Admin of; the link also stops working if that becomes so before it is used.",
          params: MemberParams,
          response: { 201: Link, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request, reply) => {
        const user = await requireUser(context, request);
        const workspace = await requireAdmin(db, user.id, request.params.workspaceId);
        return reply.code(201).send(await issueResetLink(context, user.id, workspace.id, request.params.userId));
      },
    );
  };
}
