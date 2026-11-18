import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { authenticateAgent } from "../agents/tokens.js";
import { ApiError, ErrorBody } from "../http/errors.js";
import { requireUser } from "../identity/sign-ins.js";
import { requireCaller } from "../identity/callers.js";
import { Change, changesOf } from "./changes.js";
import { addComment, Comment, commentsOn } from "./comments.js";
import { Report, reportsOn, writeReport } from "./reports.js";
import { acceptTicket, reopenTicket } from "./verification.js";
import { addRelation, Relation, RelationKind, relationsOf, removeRelation, TicketRelations } from "./relations.js";
import {
  createTicket,
  editTicket,
  findTicket,
  findTicketByKey,
  findTicketRow,
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
  const { db } = context;
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
        return reply.code(201).send(await createTicket(context, user.id, request.params.projectId, request.body));
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
        const caller = await requireCaller(context, request);
        return listTickets(db, caller, request.params.projectId, request.query);
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
        const caller = await requireCaller(context, request);
        const ticket = await findTicket(db, caller, request.params.ticketId);
        if (!ticket) throw ticketNotFound();
        return ticket;
      },
    );

    app.get(
      "/api/workspaces/:workspaceId/tickets/:key",
      {
        schema: {
          tags: ["Tickets"],
          summary: "A Ticket of a Workspace, by its key",
          description: "The key, such as `CRONK-12`, is matched ignoring case.",
          params: Type.Object({ workspaceId: Type.String(), key: Type.String() }),
          response: { 200: Ticket, 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const caller = await requireCaller(context, request);
        const ticket = await findTicketByKey(db, caller, request.params.workspaceId, request.params.key);
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
            "as first written. An Assignee must be a member of the Ticket's Workspace. A delegated Ticket entering a Status " +
            "with a Step, or delegated where it is, gets a Run. Agents never set a Status (`agent_sets_no_status`): " +
            "their Runs move Tickets with `finish`.",
          params: Type.Object({ ticketId: Type.String() }),
          body: Type.Object({
            title: Type.Optional(Title),
            description: Type.Optional(Description),
            priority: Type.Optional(Priority),
            labels: Type.Optional(Type.Array(Label, { maxItems: 50 })),
            assigneeId: Type.Optional(nullable(Type.String({ format: "uuid" }))),
            delegateId: Type.Optional(
              nullable(
                Type.String({
                  format: "uuid",
                  description:
                    "Delegates the Ticket to one of your own Agents, or `null` undelegates it. Only the Assignee " +
                    "delegates a Ticket; delegating an unassigned Ticket assigns you. A new Assignee who doesn't " +
                    "own the Delegate removes it.",
                }),
              ),
            ),
            autonomousDelegation: Type.Optional(
              Type.Boolean({
                description:
                  "Lets a Step complete the Ticket itself, as Unverified, or stops that. Only Users set it; " +
                  "its Sub-Tickets take it too.",
              }),
            ),
            dueDate: Type.Optional(nullable(Type.String({ format: "date" }))),
            estimate: Type.Optional(nullable(Type.Number({ minimum: 0, maximum: 1_000_000 }))),
            statusId: Type.Optional(
              Type.String({ format: "uuid", description: "Moves the Ticket to this Status of its Project." }),
            ),
            parentId: Type.Optional(
              nullable(
                Type.String({
                  format: "uuid",
                  description:
                    "Makes the Ticket a Sub-Ticket of this Ticket of the same Project; " +
                    "never of itself or of one of its own Sub-Tickets.",
                }),
              ),
            ),
          }),
          response: { 200: Ticket, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request) => {
        const agent = await authenticateAgent(context, request);
        if (agent && request.body.statusId !== undefined) {
          throw new ApiError(403, "agent_sets_no_status", `${agent.name} is an Agent, and Agents never set a Status.`, {
            rule: "An Agent never sets a Status: a Run moves its Ticket only by finishing with one of its Outcomes.",
            advice:
              "End your Run with `finish`, giving your Run id and one of the Outcomes your Brief offers; " +
              "the Outcome moves the Ticket.",
          });
        }
        return editTicket(context, agent ?? (await requireCaller(context, request)), request.params.ticketId, request.body);
      },
    );

    app.post(
      "/api/tickets/:ticketId/accept",
      {
        schema: {
          tags: ["Tickets"],
          summary: "Accept an Unverified Ticket",
          description:
            "Marks a Ticket a Run completed as Verified, leaving it in its Done Status. Only Users Accept; " +
            "a Ticket that isn't Unverified is refused with `not_unverified`.",
          params: Type.Object({ ticketId: Type.String() }),
          response: { 200: Ticket, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        return acceptTicket(context, user, request.params.ticketId);
      },
    );

    app.post(
      "/api/tickets/:ticketId/reopen",
      {
        schema: {
          tags: ["Tickets"],
          summary: "Reopen an Unverified Ticket",
          description:
            "Sends a Ticket a Run completed back to the Status of the Step that completed it, with a Comment saying why, " +
            "so a new Run picks it up there; it blocks again the Tickets it blocks. Only Users Reopen; a Ticket that " +
            "isn't Unverified is refused with `not_unverified`.",
          params: Type.Object({ ticketId: Type.String() }),
          body: Type.Object({
            comment: Type.String({
              minLength: 1,
              maxLength: 100_000,
              pattern: "\\S",
              description: "Why it is reopened, in Markdown; added to the Ticket's Comments.",
            }),
          }),
          response: { 200: Ticket, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        return reopenTicket(context, user, request.params.ticketId, request.body.comment);
      },
    );

    app.get(
      "/api/tickets/:ticketId/comments",
      {
        schema: {
          tags: ["Tickets"],
          summary: "A Ticket's Comments",
          description: "Oldest first. A reply names the Comment it answers.",
          params: Type.Object({ ticketId: Type.String() }),
          response: { 200: Type.Array(Comment), 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const caller = await requireCaller(context, request);
        return commentsOn(db, caller, request.params.ticketId);
      },
    );

    app.post(
      "/api/tickets/:ticketId/comments",
      {
        schema: {
          tags: ["Tickets"],
          summary: "Comment on a Ticket, or reply to a Comment",
          description: "Users and Agents with a full token may comment on any Ticket of their Workspace.",
          params: Type.Object({ ticketId: Type.String() }),
          body: Type.Object({
            body: Type.String({ minLength: 1, maxLength: 100_000, pattern: "\\S", description: "Markdown." }),
            replyToId: Type.Optional(Type.String({ description: "The Comment on this Ticket being replied to." })),
          }),
          response: { 201: Comment, 400: ErrorBody, 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request, reply) => {
        const caller = await requireCaller(context, request);
        return reply.code(201).send(await addComment(context, caller, request.params.ticketId, request.body));
      },
    );

    app.get(
      "/api/tickets/:ticketId/reports",
      {
        schema: {
          tags: ["Tickets"],
          summary: "A Ticket's Reports",
          description: "Oldest first: what its Runs wrote, each naming its Run and Agent. Later Runs on the Ticket read them.",
          params: Type.Object({ ticketId: Type.String() }),
          response: { 200: Type.Array(Report), 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => reportsOn(db, await requireCaller(context, request), request.params.ticketId),
    );

    app.post(
      "/api/tickets/:ticketId/reports",
      {
        schema: {
          tags: ["Tickets"],
          summary: "Write a Report on a Ticket",
          description:
            "For an Agent, during its own running Run on the Ticket (`no_running_run` otherwise): Markdown such as an " +
            "investigation's findings, listed with the Ticket. Users comment instead (`only_runs_report`).",
          params: Type.Object({ ticketId: Type.String() }),
          body: Type.Object({
            title: Title,
            body: Type.String({ minLength: 1, maxLength: 500_000, pattern: "\\S", description: "Markdown." }),
          }),
          response: { 201: Report, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
        },
      },
      async (request, reply) => {
        const caller = await requireCaller(context, request);
        return reply.code(201).send(await writeReport(context, caller, request.params.ticketId, request.body));
      },
    );

    app.get(
      "/api/tickets/:ticketId/relations",
      {
        schema: {
          tags: ["Tickets"],
          summary: "A Ticket's Relations, parent and Sub-Tickets",
          description:
            "Each Relation as seen from this Ticket: it blocks, is blocked by, or relates to the other. Agents may read them too.",
          params: Type.Object({ ticketId: Type.String() }),
          response: { 200: TicketRelations, 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const caller = await requireCaller(context, request);
        return relationsOf(db, caller, request.params.ticketId);
      },
    );

    app.post(
      "/api/tickets/:ticketId/relations",
      {
        schema: {
          tags: ["Tickets"],
          summary: "Relate a Ticket to another",
          description:
            "Marks that this Ticket blocks, is blocked by, or relates to another Ticket of the same Workspace, " +
            "named by its id or its key.",
          params: Type.Object({ ticketId: Type.String() }),
          body: Type.Union([
            Type.Object({ kind: RelationKind, ticketId: Type.String({ description: "The other Ticket." }) }),
            Type.Object({
              kind: RelationKind,
              ticketKey: Type.String({
                description: "The other Ticket's key, such as `CRONK-12`, matched ignoring case.",
              }),
            }),
          ]),
          response: { 201: Relation, 400: ErrorBody, 401: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request, reply) => {
        const user = await requireUser(context, request);
        return reply.code(201).send(await addRelation(context, user.id, request.params.ticketId, request.body));
      },
    );

    app.delete(
      "/api/tickets/:ticketId/relations/:relationId",
      {
        schema: {
          tags: ["Tickets"],
          summary: "Remove a Relation",
          description: "Removes a Relation of this Ticket, whichever of its two Tickets it was made from.",
          params: Type.Object({ ticketId: Type.String(), relationId: Type.String() }),
          response: { 204: Type.Null(), 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request, reply) => {
        const user = await requireUser(context, request);
        await removeRelation(context, user.id, request.params.ticketId, request.params.relationId);
        return reply.code(204).send(null);
      },
    );

    app.get(
      "/api/tickets/:ticketId/timeline",
      {
        schema: {
          tags: ["Tickets"],
          summary: "A Ticket's timeline of Changes",
          description: "Every Change to the Ticket, oldest first, with its Actor and time.",
          params: Type.Object({ ticketId: Type.String() }),
          response: { 200: Type.Array(Change), 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const caller = await requireCaller(context, request);
        const ticket = await findTicketRow(db, caller, request.params.ticketId);
        if (!ticket) throw ticketNotFound();
        return changesOf(db, ticket.id);
      },
    );
  };
}
