import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { ErrorBody } from "../http/errors.js";
import { changeDisplayName, changePassword, MeEdit, PasswordChange, requireUser, SignIn, signIn, signOut } from "./sign-ins.js";
import { isSetUp, runSetup, SetupInput } from "./setup.js";
import { User } from "./user.js";
import { LinkDetails, LinkLookup, LinkUse, lookUpLink, useLink } from "./links.js";
import { Membership, Workspace, workspacesOf } from "../workspaces/workspaces.js";

export function identityRoutes(context: Context): FastifyPluginAsyncTypebox {
  const { db, clock } = context;
  return async (app) => {
    app.get(
      "/api/setup",
      {
        schema: {
          tags: ["Setup"],
          summary: "Whether this installation still needs setting up",
          response: { 200: Type.Object({ needed: Type.Boolean() }) },
        },
      },
      async () => ({ needed: !(await isSetUp(db)) }),
    );

    app.post(
      "/api/setup",
      {
        schema: {
          tags: ["Setup"],
          summary: "Set up a fresh installation",
          description:
            "Creates the first User and their first Workspace, with that User as its Admin. Needs the setup code from Cronk's log, and works once.",
          body: SetupInput,
          response: { 201: Type.Object({ user: User, workspace: Workspace }), 403: ErrorBody, 409: ErrorBody },
        },
      },
      async (request, reply) => {
        const result = await runSetup(db, clock, request.body);
        return reply.code(201).send(result);
      },
    );

    app.post(
      "/api/sign-in",
      {
        schema: {
          tags: ["Sign-in"],
          summary: "Sign in with email and password",
          description: "Sets a sign-in cookie lasting 30 days.",
          body: SignIn,
          response: { 200: Type.Object({ user: User }), 401: ErrorBody },
        },
      },
      async (request, reply) => {
        const user = await signIn(context, reply, request.body.email, request.body.password);
        return { user };
      },
    );

    app.delete(
      "/api/sign-in",
      {
        schema: {
          tags: ["Sign-in"],
          summary: "Sign out",
          response: { 204: Type.Null() },
        },
      },
      async (request, reply) => {
        await signOut(context, request, reply);
        return reply.code(204).send(null);
      },
    );

    app.get(
      "/api/me",
      {
        schema: {
          tags: ["Sign-in"],
          summary: "The signed-in User and the Workspaces they belong to",
          response: {
            200: Type.Object({
              user: User,
              workspaces: Type.Array(Membership),
            }),
            401: ErrorBody,
          },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        return { user, workspaces: await workspacesOf(db, user.id) };
      },
    );

    app.patch(
      "/api/me",
      {
        schema: {
          tags: ["Sign-in"],
          summary: "Change one's own settings",
          description:
            "Sets the signed-in User's display name, which Cronk names them by in place of their email or GitHub login; `null` or an empty one clears it. Sign-in still goes by the email and GitHub account. Names Cronk already wrote into Changes and stop reasons keep the name they had.",
          body: MeEdit,
          response: { 200: Type.Object({ user: User }), 400: ErrorBody, 401: ErrorBody },
        },
      },
      async (request) => ({ user: await changeDisplayName(context, request, request.body.displayName) }),
    );

    app.put(
      "/api/me/password",
      {
        schema: {
          tags: ["Sign-in"],
          summary: "Change one's own password",
          description: "Needs the current password. Ends every other sign-in of the User; this one stays.",
          body: PasswordChange,
          response: { 204: Type.Null(), 400: ErrorBody, 401: ErrorBody, 403: ErrorBody },
        },
      },
      async (request, reply) => {
        await changePassword(context, request, request.body.currentPassword, request.body.newPassword);
        return reply.code(204).send(null);
      },
    );

    app.post(
      "/api/links/lookup",
      {
        schema: {
          tags: ["Links"],
          summary: "What a one-time link does",
          description:
            "Takes the secret from a join or reset link's fragment and says what using it will do, without using it.",
          body: LinkLookup,
          response: { 200: LinkDetails, 404: ErrorBody },
        },
      },
      async (request) => lookUpLink(context, request.body.token),
    );

    app.post(
      "/api/links/use",
      {
        schema: {
          tags: ["Links"],
          summary: "Use a one-time link",
          description:
            "A join link makes the User a member of its Workspace: it sets their password if they have none yet, and otherwise needs their current one (`wrong_password` if not). A reset link sets a new password and ends all the User's sign-ins. Either works once.",
          body: LinkUse,
          response: { 200: Type.Object({ user: User }), 400: ErrorBody, 403: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => ({ user: await useLink(context, request.body.token, request.body.password) }),
    );
  };
}
