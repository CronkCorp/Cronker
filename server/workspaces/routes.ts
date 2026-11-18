import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { ApiError, ErrorBody } from "../http/errors.js";
import { requireUser } from "../identity/sign-ins.js";
import { findWorkspace, Workspace } from "./workspaces.js";

export function workspaceRoutes(context: Context): FastifyPluginAsyncTypebox {
  const { db } = context;
  return async (app) => {
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
  };
}
