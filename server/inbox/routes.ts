import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { ErrorBody } from "../http/errors.js";
import { requireUser } from "../identity/sign-ins.js";
import { requireMember } from "../workspaces/members.js";
import { Inbox, inboxOf } from "./inbox.js";

export function inboxRoutes(context: Context): FastifyPluginAsyncTypebox {
  const { db } = context;
  return async (app) => {
    app.get(
      "/api/workspaces/:workspaceId/inbox",
      {
        schema: {
          tags: ["Inbox"],
          summary: "The signed-in User's Inbox in a Workspace",
          description:
            "Everything in the Workspace waiting on the signed-in User, worked out from current state: " +
            "Questions Runs asked on Tickets assigned to them, until answered or dismissed; Tickets a *needs you* Outcome moved, " +
            "until they move again; Tickets in a Review Status, and Tickets a Run completed that are still Unverified, whose Assignee they are; Tickets delegated to their Agents " +
            "whose latest Run failed, was lost or couldn't start while they are still in its Status, to Retry; " +
            "and Discovered Tickets assigned to them, until they delegate, move or dismiss them.",
          params: Type.Object({ workspaceId: Type.String() }),
          response: { 200: Inbox, 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        const workspace = await requireMember(db, user.id, request.params.workspaceId);
        return inboxOf(db, user.id, workspace.id);
      },
    );
  };
}
