import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { ErrorBody } from "../http/errors.js";
import { isSetUp, runSetup } from "./setup.js";

const User = Type.Object({ id: Type.String({ format: "uuid" }), email: Type.String() });
const Workspace = Type.Object({ id: Type.String({ format: "uuid" }), name: Type.String() });
const Email = Type.String({ format: "email", maxLength: 320 });
const Password = Type.String({ minLength: 8, maxLength: 1024 });

export function identityRoutes({ db, clock }: Context): FastifyPluginAsyncTypebox {
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
  };
}
