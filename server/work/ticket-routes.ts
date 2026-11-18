import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { ErrorBody } from "../http/errors.js";
import { requireUser } from "../identity/sign-ins.js";
import {
  createTicket,
  editTicket,
  findTicket,
  listTickets,
  Priority,
  Ticket,
  ticketNotFound,
  TicketSummary,
} from "./tickets.js";

const Title = Type.String({ minLength: 1, maxLength: 300, pattern: "\\S" });
const Description = Type.String({ maxLength: 100_000, description: "Markdown." });
const Label = Type.String({ minLength: 1, maxLength: 50, pattern: "\\S" });
// Null comes first: the body's type coercion would otherwise turn null into 0 or "".
const nullable = <T extends Parameters<typeof Type.Union>[0][number]>(schema: T) => Type.Union([Type.Null(), schema]);

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
          description: "In board order of their Statuses, then by key, narrowed by whichever filters are given.",
          params: Type.Object({ projectId: Type.String() }),
          querystring: Type.Object({
            statusId: Type.Optional(Type.String()),
            assigneeId: Type.Optional(
              Type.String({ description: "A User's id, or `none` for Tickets without an Assignee." }),
            ),
            priority: Type.Optional(Priority),
            label: Type.Optional(Type.String({ description: "Matched ignoring case." })),
          }),
          response: { 200: Type.Array(TicketSummary), 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        return listTickets(db, user.id, request.params.projectId, request.query);
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

    app.patch(
      "/api/tickets/:ticketId",
      {
        schema: {
          tags: ["Tickets"],
          summary: "Edit a Ticket",
          description:
            "Changes whichever fields are given; `null` clears a field. Labels that differ only in case are kept once, " +
            "as first written. An Assignee must be a member of the Ticket's Workspace.",
          params: Type.Object({ ticketId: Type.String() }),
          body: Type.Object({
            title: Type.Optional(Title),
            description: Type.Optional(Description),
            priority: Type.Optional(Priority),
            labels: Type.Optional(Type.Array(Label, { maxItems: 50 })),
            assigneeId: Type.Optional(nullable(Type.String({ format: "uuid" }))),
            dueDate: Type.Optional(nullable(Type.String({ format: "date" }))),
            estimate: Type.Optional(nullable(Type.Number({ minimum: 0, maximum: 1_000_000 }))),
            statusId: Type.Optional(
              Type.String({ format: "uuid", description: "Moves the Ticket to this Status of its Project." }),
            ),
          }),
          response: { 200: Ticket, 400: ErrorBody, 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        return editTicket(db, user.id, request.params.ticketId, request.body);
      },
    );
  };
}
