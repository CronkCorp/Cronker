import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { ApiError, ErrorBody } from "../http/errors.js";
import { Email } from "../identity/user.js";
import {
  AddedMember,
  addMember,
  issueResetLink,
  Member,
  membersOf,
  removeMember,
  requireAdmin,
  requireMember,
  setAdmin,
} from "./members.js";
import { requireUser } from "../identity/sign-ins.js";
import { createWorkspace, findWorkspace, Membership, renameWorkspace, Workspace, WorkspaceName } from "./workspaces.js";
import { Link } from "../identity/links.js";

export function workspaceRoutes(context: Context): FastifyPluginAsyncTypebox {
  const { db, clock } = context;
  return async (app) => {
    app.post(
      "/api/workspaces",
      {
        schema: {
          tags: ["Workspaces"],
          summary: "Create a Workspace",
          description: "Any signed-in User may create a Workspace, and becomes its Admin.",
          body: Type.Object({ name: WorkspaceName }),
          response: { 201: Membership, 401: ErrorBody },
        },
      },
      async (request, reply) => {
        const user = await requireUser(context, request);
        return reply.code(201).send(await createWorkspace(db, clock, user.id, request.body.name));
      },
    );

    app.get(
      "/api/workspaces/:workspaceId",
      {
        schema: {
          tags: ["Workspaces"],
          summary: "A Workspace the signed-in User belongs to",
          params: Type.Object({ workspaceId: Type.String() }),
          response: { 200: Workspace, 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        const workspace = await findWorkspace(db, user.id, request.params.workspaceId);
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
          body: Type.Object({ name: WorkspaceName }),
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
        const user = await requireUser(context, request);
        const workspace = await requireMember(db, user.id, request.params.workspaceId);
        return membersOf(db, workspace.id);
      },
    );

    app.post(
      "/api/workspaces/:workspaceId/members",
      {
        schema: {
          tags: ["Workspaces"],
          summary: "Add someone by email (Admins only)",
          description:
            "Someone who can already sign in joins at once. Anyone else gets a one-time link, valid 7 days, for the Admin to pass on: using it sets their password and joins them.",
          params: Type.Object({ workspaceId: Type.String() }),
          body: Type.Object({ email: Email }),
          response: { 201: AddedMember, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request, reply) => {
        const user = await requireUser(context, request);
        const workspace = await requireAdmin(db, user.id, request.params.workspaceId);
        return reply.code(201).send(await addMember(context, workspace.id, request.body.email.trim()));
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
          body: Type.Object({ isAdmin: Type.Boolean() }),
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
        await removeMember(db, workspace.id, request.params.userId);
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
            "A one-time link, valid 7 days, for the Admin to pass on. Using it sets a new password and ends the member's sign-ins.",
          params: MemberParams,
          response: { 201: Link, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
        },
      },
      async (request, reply) => {
        const user = await requireUser(context, request);
        const workspace = await requireAdmin(db, user.id, request.params.workspaceId);
        return reply.code(201).send(await issueResetLink(context, workspace.id, request.params.userId));
      },
    );
  };
}
