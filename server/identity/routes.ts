import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { ErrorBody } from "../http/errors.js";
import { requireUser, signIn, signOut } from "./sign-ins.js";
import { isSetUp, runSetup } from "./setup.js";
import { User } from "./user.js";
import { Membership, Workspace, workspacesOf } from "../workspaces/workspaces.js";

const Email = Type.String({ format: "email", maxLength: 320 });
const Password = Type.String({ minLength: 8, maxLength: 1024 });

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
          body: Type.Object({
            setupCode: Type.String(),
            email: Email,
            password: Password,
            workspaceName: Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" }),
          }),
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
          body: Type.Object({ email: Type.String(), password: Type.String() }),
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
  };
}
