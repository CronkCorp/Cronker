import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { ApiError, ErrorBody } from "../http/errors.js";
import { requireUser } from "../identity/sessions.js";

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
          response: { 200: Type.Object({ id: Type.String(), name: Type.String() }), 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        // Anything outside the User's Workspaces answers as if it didn't exist.
        const { rows } = await db.query<{ id: string; name: string }>(
          `select workspaces.id, workspaces.name
           from workspaces join memberships on memberships.workspace_id = workspaces.id
           where workspaces.id::text = $1 and memberships.user_id = $2`,
          [request.params.workspaceId, user.id],
        );
        if (!rows[0]) throw new ApiError(404, "not_found", "No such Workspace.");
        return rows[0];
      },
    );
  };
}
