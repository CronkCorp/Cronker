import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { ErrorBody } from "../http/errors.js";
import { requireUser, signIn, signOut } from "./sessions.js";
import { isSetUp, runSetup } from "./setup.js";

const User = Type.Object({ id: Type.String({ format: "uuid" }), email: Type.String() });
const Workspace = Type.Object({ id: Type.String({ format: "uuid" }), name: Type.String() });
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
      "/api/session",
      {
        schema: {
          tags: ["Sessions"],
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
      "/api/session",
      {
        schema: {
          tags: ["Sessions"],
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
          tags: ["Sessions"],
          summary: "The signed-in User and the Workspaces they belong to",
          response: {
            200: Type.Object({
              user: User,
              workspaces: Type.Array(Type.Object({ id: Type.String(), name: Type.String(), isAdmin: Type.Boolean() })),
            }),
            401: ErrorBody,
          },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        const { rows } = await db.query<{ id: string; name: string; isAdmin: boolean }>(
          `select workspaces.id, workspaces.name, memberships.is_admin as "isAdmin"
           from memberships join workspaces on workspaces.id = memberships.workspace_id
           where memberships.user_id = $1 order by workspaces.name, workspaces.id`,
          [user.id],
        );
        return { user, workspaces: rows };
      },
    );
  };
}
