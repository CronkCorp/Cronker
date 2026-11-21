import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { ErrorBody } from "../http/errors.js";
import { requireCaller } from "../identity/callers.js";
import { requireUser } from "../identity/sign-ins.js";
import { Brief, previewBrief } from "./brief.js";
import { dismissQuestion } from "./questions.js";
import { createRunner, removeRunner, removeTrigger, RunnerRecord, runnersOf, saveTrigger, setRunnerLimit } from "./runners.js";
import { briefOfRun, findRun, finishRun, retryRun, Run, runsOf } from "./runs.js";
import { mergePullRequest } from "./merging.js";
import { Ticket } from "../work/tickets.js";
import { ModelLabel } from "../workspaces/model-ids.js";

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

    app.post(
      "/api/runs/:runId/merge",
      {
        schema: {
          tags: ["Runs"],
          summary: "Merge the Run's Ticket's Pull Request",
          description:
            "For the caller's own running Run of a Merge Step: merges a Pull Request linked to the Run's Ticket on GitHub, " +
            "with the GitHub App's token and the Repository's default merge method (the first its settings allow of a " +
            "merge commit, squashing and rebasing), only while its head is the commit Cronk knows. Refused, naming the " +
            "rule, unless the Ticket has Autonomous Delegation, its Project has agents may merge on, the Pull Request is " +
            "open, its checks on its latest commit are green with none pending, no review still requests changes, and " +
            "GitHub says it is mergeable. The merge ends the Run, finished with the Outcome `merged`, without `finish`, " +
            "and completes the Ticket as Unverified, recorded as the Agent's in that Run.",
          params: RunParams,
          body: Type.Object({
            pullRequestId: Type.Integer({ description: "GitHub's id for the Pull Request, as the Ticket's Pull Requests list it." }),
          }),
          response: { 200: Run, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody, 502: ErrorBody },
        },
      },
      async (request) =>
        mergePullRequest(context, await requireCaller(context, request), request.params.runId, request.body.pullRequestId),
    );

    app.post(
      "/api/questions/:questionId/dismiss",
      {
        schema: {
          tags: ["Runs"],
          summary: "Dismiss a Question",
          description:
            "Removes the Question from its Ticket's Assignee's Inbox without moving the Ticket. The Question stays on " +
            "the Ticket as its Comment, and the first User's reply to that Comment still answers it. Users only.",
          params: Type.Object({ questionId: Type.String() }),
          response: { 204: Type.Null(), 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
        },
      },
      async (request, reply) => {
        const user = await requireUser(context, request);
        await dismissQuestion(context, { kind: "user", id: user.id }, request.params.questionId);
        return reply.code(204).send(null);
      },
    );

    app.post(
      "/api/tickets/:ticketId/retry",
      {
        schema: {
          tags: ["Runs"],
          summary: "Retry a Ticket whose latest Run went wrong",
          description:
            "Starts a fresh Run of the same Step on a delegated Ticket whose latest Run failed, was lost or couldn't " +
            "start, while the Ticket is still in that Run's Status; refused with `nothing_to_retry` otherwise. Only the " +
            "Delegate's Owner retries, since the Run spends their credentials. Nothing retries by itself. Like any " +
            "Ticket needing a Run, it waits while its Runner is full or it is blocked. Returns the Ticket: its " +
            "`lastRun` is the new Run, or its `waiting` says what it waits for.",
          params: Type.Object({ ticketId: Type.String() }),
          response: { 200: Ticket, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request) => retryRun(context, (await requireUser(context, request)).id, request.params.ticketId),
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

    app.patch(
      "/api/runners/:runnerId",
      {
        schema: {
          tags: ["Runs"],
          summary: "Set your Runner's limit on Runs at once",
          description:
            "Tickets needing a Run beyond the limit wait for a slot, highest Priority first, then the one that entered " +
            "its Status first. Raising the limit starts waiting Tickets at once; lowering it stops no running Run.",
          params: Type.Object({ runnerId: Type.String() }),
          body: Type.Object({ limit: Type.Integer({ minimum: 1, maximum: 100 }) }),
          response: { 200: RunnerRecord, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        return setRunnerLimit(context, user.id, request.params.runnerId, request.body.limit);
      },
    );

    app.delete(
      "/api/runners/:runnerId",
      {
        schema: {
          tags: ["Runs"],
          summary: "Remove your Runner",
          description:
            "Removes it with its triggers. Agents pointed at it are left with no Runner, so their delegated Tickets get " +
            "Runs refused until their Owner points them at another; its past Runs keep their history without it. " +
            "Refused with `runner_running` while one of its Runs is running.",
          params: Type.Object({ runnerId: Type.String() }),
          response: { 204: Type.Null(), 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request, reply) => {
        const user = await requireUser(context, request);
        await removeRunner(context, user.id, request.params.runnerId);
        return reply.code(204).send(null);
      },
    );

    app.post(
      "/api/runners/:runnerId/triggers",
      {
        schema: {
          tags: ["Runs"],
          summary: "Save a trigger of your subscription Runner",
          description:
            "The claude.ai scheduled task your `subscription` Runner fires for Steps wanting the model, with its API " +
            "trigger's id and token. With a `projectId`, it overrides the Runner's own trigger for the model on that " +
            "Project's Tickets. Replaces the trigger saved for the same model and Project. The token is stored " +
            "encrypted and never returned. Refused with `runner_has_no_triggers` for other kinds of Runner, and with " +
            "`no_secret_key` while Cronk has no `CRONK_SECRET_KEY`.",
          params: Type.Object({ runnerId: Type.String() }),
          body: Type.Object({
            model: ModelLabel,
            projectId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
            triggerId: Type.String({ minLength: 1, maxLength: 200, pattern: "^\\s*[A-Za-z0-9_-]+\\s*$" }),
            token: Type.String({ minLength: 1, maxLength: 1000, pattern: "\\S" }),
          }),
          response: { 200: RunnerRecord, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        return saveTrigger(context, user.id, request.params.runnerId, request.body);
      },
    );

    app.delete(
      "/api/runners/:runnerId/triggers/:triggerId",
      {
        schema: {
          tags: ["Runs"],
          summary: "Remove a trigger of your subscription Runner",
          description: "Runs needing it then couldn't start, with the reason in your Inbox, until another is saved.",
          params: Type.Object({ runnerId: Type.String(), triggerId: Type.String() }),
          response: { 200: RunnerRecord, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        return removeTrigger(context, user.id, request.params.runnerId, request.params.triggerId);
      },
    );
  };
}
