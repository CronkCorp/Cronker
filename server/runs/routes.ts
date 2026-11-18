import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { ErrorBody } from "../http/errors.js";
import { requireCaller } from "../identity/callers.js";
import { requireUser } from "../identity/sign-ins.js";
import { Brief, previewBrief } from "./brief.js";
import { createRunner, RunnerRecord, runnersOf } from "./runners.js";
import { briefOfRun, findRun, finishRun, Run, runsOf } from "./runs.js";

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

    const RunParams = Type.Object({ runId: Type.String() });

    app.get(
      "/api/tickets/:ticketId/runs",
      {
        schema: {
          tags: ["Runs"],
          summary: "A Ticket's Runs",
          description: "Oldest first, with each Run's Step, Agent, model, state, times and session link.",
          params: Type.Object({ ticketId: Type.String() }),
          response: { 200: Type.Array(Run), 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => runsOf(context.db, await requireCaller(context, request), request.params.ticketId),
    );

    app.get(
      "/api/runs/:runId",
      {
        schema: {
          tags: ["Runs"],
          summary: "A Run",
          params: RunParams,
          response: { 200: Run, 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => findRun(context.db, await requireCaller(context, request), request.params.runId),
    );

    app.get(
      "/api/runs/:runId/brief",
      {
        schema: {
          tags: ["Runs"],
          summary: "The full Brief a Run started from",
          params: RunParams,
          response: { 200: Brief, 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => briefOfRun(context.db, await requireCaller(context, request), request.params.runId),
    );

    app.post(
      "/api/runs/:runId/finish",
      {
        schema: {
          tags: ["Runs"],
          summary: "Finish a Run with an Outcome",
          description:
            "Ends the caller's own running Run with one of the Outcomes its Brief offers, and moves its Ticket to the " +
            "Outcome's Status in the same transaction; a Status with a Step starts the next Run. Only the Run's Agent " +
            "may finish it, once, and only while its Ticket is still in the Status the Run started in.",
          params: RunParams,
          body: Type.Object({
            outcome: Type.String({ minLength: 1, maxLength: 50, description: "The Outcome's name, matched ignoring case." }),
            question: Type.Optional(Type.String({ minLength: 1, maxLength: 100_000, description: "For the Assignee, in Markdown." })),
            report: Type.Optional(
              Type.String({
                minLength: 1,
                maxLength: 500_000,
                pattern: "\\S",
                description: "Markdown, added to the Ticket's Reports titled after the Run's Step, such as `Triage report`.",
              }),
            ),
          }),
          response: { 200: Run, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request) => finishRun(context, await requireCaller(context, request), request.params.runId, request.body),
    );

    app.get(
      "/api/runners",
      {
        schema: {
          tags: ["Runs"],
          summary: "Your Runners",
          response: { 200: Type.Array(RunnerRecord), 401: ErrorBody, 403: ErrorBody },
        },
      },
      async (request) => runnersOf(context.db, (await requireUser(context, request)).id),
    );

    app.post(
      "/api/runners",
      {
        schema: {
          tags: ["Runs"],
          summary: "Set up a Runner of your own",
          description: "Refused with `unknown_runner_kind` for a kind of Runner this Cronk doesn't have.",
          body: Type.Object({
            name: Type.String({ minLength: 1, maxLength: 100, pattern: "\\S" }),
            kind: Type.String({ minLength: 1, maxLength: 50 }),
          }),
          response: { 201: RunnerRecord, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody },
        },
      },
      async (request, reply) => {
        const user = await requireUser(context, request);
        return reply.code(201).send(await createRunner(context, user.id, request.body));
      },
    );
  };
}
