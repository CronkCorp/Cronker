import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { ErrorBody } from "../http/errors.js";
import { requireCaller } from "../identity/callers.js";
import { Brief, previewBrief } from "./brief.js";

export function runRoutes(context: Context): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get(
      "/api/tickets/:ticketId/brief",
      {
        schema: {
          tags: ["Runs"],
          summary: "Preview the Brief a Run on the Ticket would receive",
          description:
            "For a Ticket in a Status with a Step: Cronk's preamble, the Step's Brief and the Ticket key, " +
            "as a Run started now would receive them, but for the Run id. Refused for a Status without a Step.",
          params: Type.Object({ ticketId: Type.String() }),
          response: { 200: Brief, 401: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request) => previewBrief(context, await requireCaller(context, request), request.params.ticketId),
    );
  };
}
