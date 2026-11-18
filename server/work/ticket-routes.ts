import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { ErrorBody } from "../http/errors.js";
import { requireUser } from "../identity/sign-ins.js";
import { createTicket, findTicket, listTickets, Ticket, ticketNotFound, TicketSummary } from "./tickets.js";

const Title = Type.String({ minLength: 1, maxLength: 300, pattern: "\\S" });
const Description = Type.String({ maxLength: 100_000, description: "Markdown." });

export function ticketRoutes(context: Context): FastifyPluginAsyncTypebox {
  const { db, clock } = context;
  return async (app) => {
    app.post(
      "/api/projects/:projectId/tickets",
      {
        schema: {
          tags: ["Tickets"],
          summary: "Create a Ticket",
          description: "Creates a Ticket with the Project's next key, in the Project's first Backlog Status.",
          params: Type.Object({ projectId: Type.String() }),
          body: Type.Object({ title: Title, description: Type.Optional(Description) }),
          response: { 201: Ticket, 400: ErrorBody, 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request, reply) => {
        const user = await requireUser(context, request);
        return reply.code(201).send(await createTicket(db, clock, user.id, request.params.projectId, request.body));
      },
    );

    app.get(
      "/api/projects/:projectId/tickets",
      {
        schema: {
          tags: ["Tickets"],
          summary: "The Project's Tickets",
          description: "In board order of their Statuses, then by key.",
          params: Type.Object({ projectId: Type.String() }),
          response: { 200: Type.Array(TicketSummary), 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        return listTickets(db, user.id, request.params.projectId);
      },
    );

    app.get(
      "/api/tickets/:ticketId",
      {
        schema: {
          tags: ["Tickets"],
          summary: "A Ticket",
          params: Type.Object({ ticketId: Type.String() }),
          response: { 200: Ticket, 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        const ticket = await findTicket(db, user.id, request.params.ticketId);
        if (!ticket) throw ticketNotFound();
        return ticket;
      },
    );
  };
}
