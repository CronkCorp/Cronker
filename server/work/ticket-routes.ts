import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { authenticateAgent } from "../agents/tokens.js";
import { ApiError, ErrorBody } from "../http/errors.js";
import { requireUser } from "../identity/sign-ins.js";
import { requireCaller } from "../identity/callers.js";
import { requireHuman, requireOwnerAct, requireOwnerCaller } from "../identity/acts.js";
import { Change, changesOf } from "./changes.js";
import { joinQueue, leaveQueue } from "../pipeline/merge-queue.js";
import { addComment, Comment, CommentCreate, commentsOn } from "./comments.js";
import { Report, ReportCreate, writeReport } from "../knowledge/reports.js";
import { ReportWithThreads, reportsWithThreads } from "../knowledge/ticket-threads.js";
import { placeOfDocument } from "../knowledge/documents.js";
import { given, warnAgent, withAvoidedWords } from "../http/avoided-words.js";
import { placeOfComment, placeOfTicket } from "../knowledge/places.js";
import { acceptTicket, Completion, completionOf, ReopenPreview, reopenPreview, reopenTicket, TicketReopen } from "./verification.js";
import { addRelation, Relation, RelationCreate, relationsOf, removeRelation, TicketRelations } from "./relations.js";
import {
  createTicket,
  dismissTicket,
  editTicket,
  findTicket,
  findTicketByKey,
  findTicketRow,
  listTickets,
  Priority,
  Ticket,
  TicketCreate,
  TicketEdit,
  ticketNotFound,
  TicketList,
} from "./tickets.js";

export function ticketRoutes(context: Context): FastifyPluginAsyncTypebox {
  const { db } = context;
  return async (app) => {
    app.post(
      "/api/projects/:projectId/tickets",
      {
        schema: {
          tags: ["Tickets"],
          summary: "Create a Ticket",
          description:
            "Creates a Ticket with the Project's next key, in the Project's first Backlog Status. A Sub-Ticket, given " +
            "its `parentId`, starts with its parent's Assignee and Delegation. Agents create Tickets too: during its " +
            "running Run an Agent may split its Run's Ticket into Sub-Tickets. Any other Ticket an Agent files is a " +
            "Discovered Ticket: undelegated, assigned to the Assignee of the Ticket of the Run it names in `runId` " +
            "(or, naming none, to the Agent's Owner), and waiting in their Inbox until a User delegates, moves or " +
            "dismisses it. Until then the Agent may also split it, in or outside a Run: its Sub-Tickets are " +
            "Discovered Tickets of the same Agent and source, waiting with their parent rather than in the Inbox, " +
            "and settled along with it. An Agent gets `not_your_discovered_ticket` for any other Discovered Ticket as parent, and `no_running_run` for any other parent. " +
            "An Agent's save answers with `avoidedWords`: the words the Project's glossary avoids that its title and description use.",
          params: Type.Object({ projectId: Type.String() }),
          body: TicketCreate,
          response: { 201: withAvoidedWords(Ticket), 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
        },
      },
      async (request, reply) => {
        const caller = await requireCaller(context, request);
        const ticket = await createTicket(context, caller, request.params.projectId, request.body);
        const texts = given({ plain: [request.body.title], markdown: [request.body.description] });
        return reply.code(201).send(await warnAgent(db, caller, await placeOfTicket(db, ticket.id), texts, ticket));
      },
    );

    app.get(
      "/api/projects/:projectId/tickets",
      {
        schema: {
          tags: ["Tickets"],
          summary: "The Project's Tickets",
          description: "In board order of their Statuses; within one, Tickets in the Merge Queue first by their place in it, then " +
            "those with a running Run, then the rest, blocked or not, each by key; narrowed by whichever filters are given.",
          params: Type.Object({ projectId: Type.String() }),
          querystring: Type.Object({
            statusId: Type.Optional(Type.String()),
            assigneeId: Type.Optional(
              Type.String({ description: "A User's id, or `none` for Tickets without an Assignee." }),
            ),
            priority: Type.Optional(Priority),
            label: Type.Optional(Type.String({ description: "Matched ignoring case." })),
            release: Type.Optional(
              Type.String({ description: "A Release's name, matched ignoring case, or `none` for Tickets without one." }),
            ),
          }),
          response: { 200: TicketList, 401: ErrorBody, 404: ErrorBody },
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
            "with a Step, or delegated where it is, gets a Run. An Agent may set or clear the parent of any Ticket of a " +
            "Project it has a running Run in, alone in its edit, and otherwise gets `no_running_run`. Agents without a Full token never set a Status: " +
            "their Runs move Tickets with `finish`; an Agent with a Write token is refused with `full_token_needed`. An Agent with a Full token moves any Ticket it has Write on, alone in its edit, as its Owner's move: entering a Status with a Step starts its Run and leaving a running one stops it, each a Change by the Agent with no Run. An Agent's save answers with `avoidedWords`: the words the " +
            "Project's glossary avoids that the title and description it gives use.",
          params: Type.Object({ ticketId: Type.String() }),
          body: TicketEdit,
          response: { 200: withAvoidedWords(Ticket), 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request) => {
        const agent = await authenticateAgent(context, request);
        if (agent && request.body.statusId !== undefined) {
          requireOwnerAct(agent, {
            act: "moving a Ticket",
            rule:
              "An Agent with a Write token never sets a Status: a Run moves its Ticket only by finishing with one of its " +
              "Outcomes, so end your Run with `finish`.",
          });
        }
        const caller = agent ?? (await requireCaller(context, request));
        const ticket = await editTicket(context, caller, request.params.ticketId, request.body);
        const texts = given({ plain: [request.body.title], markdown: [request.body.description] });
        return warnAgent(db, caller, await placeOfTicket(db, ticket.id), texts, ticket);
      },
    );

    app.post(
      "/api/tickets/:ticketId/dismiss",
      {
        schema: {
          tags: ["Tickets"],
          summary: "Dismiss a Discovered Ticket",
          description:
            "Takes a Discovered Ticket waiting for a User out of its Assignee's Inbox, and out of the hands of the " +
            "Agent that filed it, leaving it where it is. Delegating or moving it does the same. Refused for any " +
            "other Ticket (`not_waiting`).",
          params: Type.Object({ ticketId: Type.String() }),
          response: { 200: Ticket, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        return dismissTicket(context, user.id, request.params.ticketId);
      },
    );

    app.post(
      "/api/tickets/:ticketId/merge",
      {
        schema: {
          tags: ["Tickets"],
          summary: "Merge a Ticket through the Merge Queue",
          description:
            "Queues the Ticket's first open linked Pull Request in the Merge Queue for its Repository and base branch and " +
            "moves the Ticket into its Project's Merge Status, as the User's move. Cronk merges each queue's head in turn, " +
            "once it is clean and green, as this User's merge, completing the Ticket as Verified. Needs Write; refused, " +
            "naming the rule, unless the Ticket is in a Review Status (`not_in_review`), its Project has Pull Request " +
            "automation on (`pull_request_automation_off`) and a Merge Status (`no_merge_status`), and it has an open " +
            "linked Pull Request (`no_open_pull_request`). Only Users and Agents with a Full token merge this way: a " +
            "Full Agent's merge is recorded as its Agent's and completes the Ticket as Unverified, whether or not the " +
            "Project lets agents merge; an Agent with a Write token gets `full_token_needed`.",
          params: Type.Object({ ticketId: Type.String() }),
          response: { 200: Ticket, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request) => {
        const caller = await requireOwnerCaller(context, request, {
          act: "queueing a merge",
          rule: "Merge queues a Ticket as a User's act; a Run's merge goes through its Merge Step.",
        });
        return joinQueue(context, caller, request.params.ticketId);
      },
    );

    app.post(
      "/api/tickets/:ticketId/queue/remove",
      {
        schema: {
          tags: ["Tickets"],
          summary: "Remove a Ticket from the Merge Queue",
          description:
            "Sends a Ticket in the Merge Queue back to its Project's first Review Status, as the User's move, taking its " +
            "Pull Request out of the queue. Needs Write; refused for a Ticket not in the queue (`not_queued`) or while " +
            "Cronk is merging it (`merging`). Users and Agents with a Full token remove; an Agent with a Write " +
            "token gets `full_token_needed`.",
          params: Type.Object({ ticketId: Type.String() }),
          response: { 200: Ticket, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request) => {
        const caller = await requireOwnerCaller(context, request, {
          act: "removing a Ticket from the Merge Queue",
          rule: "Remove from queue moves the Ticket back to Review as a User's act.",
        });
        return leaveQueue(context, caller, request.params.ticketId);
      },
    );

    app.post(
      "/api/tickets/:ticketId/accept",
      {
        schema: {
          tags: ["Tickets"],
          summary: "Accept an Unverified Ticket",
          description:
            "Marks a Ticket a Run completed as Verified, leaving it in its Done Status. Only Users Accept; an Agent with a Full token gets `human_only`; " +
            "a Ticket that isn't Unverified is refused with `not_unverified`.",
          params: Type.Object({ ticketId: Type.String() }),
          response: { 200: Ticket, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request) => {
        const user = await requireHuman(context, request, "Accept a Ticket");
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
            "so a new Run picks it up there; it blocks again the Tickets it blocks. Cronk writes a Comment, naming it and " +
            "quoting the reason, on each Ticket it blocks that moved on since it was completed (see `reopen-preview`) and " +
            "the User may read, saying whether it was sent back. Those named in `sendBack` are sent back to their " +
            "Project's first Backlog Status, as the User's Change, stopping any running Run; they stay blocked by it. " +
            "A `sendBack` naming a Ticket the preview doesn't list is refused with `not_in_preview`, and one in a Project " +
            "where the User lacks Write with `read_access`, before anything changes. Only Users Reopen (`human_only` for a Full token); a Ticket that " +
            "isn't Unverified is refused with `not_unverified`.",
          params: Type.Object({ ticketId: Type.String() }),
          body: TicketReopen,
          response: { 200: Ticket, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request) => {
        const user = await requireHuman(context, request, "Reopen a Ticket");
        return reopenTicket(context, user, request.params.ticketId, request.body.comment, request.body.sendBack);
      },
    );

    app.get(
      "/api/tickets/:ticketId/completion",
      {
        schema: {
          tags: ["Tickets"],
          summary: "What completed a Ticket, and where Reopen sends it",
          description:
            "For a Ticket a Run or a merged Pull Request completed (Unverified or Verified): the merged Pull Request and who " +
            "merged it, if a merge did, and where Reopen sends it. Null for a Ticket nothing completed.",
          params: Type.Object({ ticketId: Type.String() }),
          response: { 200: Type.Union([Completion, Type.Null()]), 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const caller = await requireCaller(context, request);
        return completionOf(context.db, caller, request.params.ticketId);
      },
    );

    app.get(
      "/api/tickets/:ticketId/reopen-preview",
      {
        schema: {
          tags: ["Tickets"],
          summary: "What Reopening a Ticket would reach besides it",
          description:
            "For an Unverified Ticket: the Tickets it blocks that moved on since it was completed, leaving a Backlog Status " +
            "or having a Run start then or later, each with its Status and whether a Run is running. Reopening it writes " +
            "a Comment by Cronk on each, naming it and quoting the reason. Only those the caller may read are listed.",
          params: Type.Object({ ticketId: Type.String() }),
          response: { 200: ReopenPreview, 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const caller = await requireCaller(context, request);
        return reopenPreview(context.db, caller, request.params.ticketId);
      },
    );

    app.get(
      "/api/tickets/:ticketId/comments",
      {
        schema: {
          tags: ["Tickets"],
          summary: "A Ticket's Comments",
          description:
            "Oldest first. A reply names the Comment it answers. The Comments on the Ticket's Linked Artifacts the " +
            "caller can read are among them, each naming its Artifact; replies to those go to the Artifact.",
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
          description:
            "Users and Agents with a full token may comment on any Ticket of their Workspace. An Agent's Comment " +
            "answers with `avoidedWords`: the words the glossary avoids that its body uses, by the Project of the " +
            "Ticket, or of the Artifact a reply goes to.",
          params: Type.Object({ ticketId: Type.String() }),
          body: CommentCreate,
          response: { 201: withAvoidedWords(Comment), 400: ErrorBody, 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request, reply) => {
        const caller = await requireCaller(context, request);
        const comment = await addComment(context, caller, request.params.ticketId, request.body);
        const place = await placeOfComment(db, comment);
        return reply.code(201).send(await warnAgent(db, caller, place, { markdown: [request.body.body] }, comment));
      },
    );

    app.get(
      "/api/tickets/:ticketId/reports",
      {
        schema: {
          tags: ["Tickets"],
          summary: "A Ticket's Reports",
          description:
            "Oldest first: what its Runs wrote, each naming its Run and Agent, with its unresolved threads. Later Runs " +
            "on the Ticket read them.",
          params: Type.Object({ ticketId: Type.String() }),
          response: { 200: Type.Array(ReportWithThreads), 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => reportsWithThreads(db, await requireCaller(context, request), request.params.ticketId),
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
          body: ReportCreate,
          response: { 201: withAvoidedWords(Report), 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
        },
      },
      async (request, reply) => {
        const caller = await requireCaller(context, request);
        const report = await writeReport(context, caller, request.params.ticketId, request.body);
        const { title, body } = request.body;
        const place = await placeOfDocument(db, report.id);
        return reply.code(201).send(await warnAgent(db, caller, place, { plain: [title], markdown: [body] }, report));
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
            "named by its id or its key. An Agent adds only blocks (`agent_adds_only_blocks`), and only where " +
            "one of the two Tickets is a Discovered Ticket it filed that still waits for a User " +
            "(`not_your_discovered_ticket`): from it to any Ticket, or to it from any Ticket.",
          params: Type.Object({ ticketId: Type.String() }),
          body: RelationCreate,
          response: { 201: Relation, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request, reply) => {
        const caller = await requireCaller(context, request);
        return reply.code(201).send(await addRelation(context, caller, request.params.ticketId, request.body));
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
        return changesOf(db, caller, ticket.id);
      },
    );
  };
}
