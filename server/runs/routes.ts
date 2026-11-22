import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { authenticateAgent } from "../agents/tokens.js";
import { deliveryRoute } from "../http/deliveries.js";
import { given, warnAgent, withAvoidedWords } from "../http/avoided-words.js";
import { ApiError, ErrorBody } from "../http/errors.js";
import { placeOfTicket } from "../knowledge/places.js";
import { requireCaller } from "../identity/callers.js";
import { requireUser } from "../identity/sign-ins.js";
import { Brief, previewBrief } from "./brief.js";
import { dismissQuestion } from "./questions.js";
import {
  createRunner,
  forgetWebhookSecret,
  pasteTriggerToken,
  removeRunner,
  removeTrigger,
  RunnerRecord,
  Trigger,
  runnersOf,
  saveTrigger,
  saveWebhookSecret,
  updateRunner,
  BudgetPerRun,
} from "./runners.js";
import { managedAgentsWebhookPath, receiveManagedAgentsDelivery } from "./managed-agents.js";
import { instructionsPath, reportSetup, setupInstructions, startSetup, StartedSetup } from "./runner-setups.js";
import { briefOfRun, findRun, finishRun, retryRun, Run, runReports, runsOf } from "./runs.js";
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
            "may finish it, once, and only while its Ticket is still in the Status the Run started in. It answers with " +
            "`avoidedWords`: the words the Project's glossary avoids that the Report and Question use.",
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
          response: { 200: withAvoidedWords(Run), 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request) => {
        const caller = await requireCaller(context, request);
        const run = await finishRun(context, caller, request.params.runId, request.body);
        const texts = given({ markdown: [request.body.report, request.body.question] });
        return warnAgent(context.db, caller, await placeOfTicket(context.db, run.ticketId), texts, run);
      },
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
      async (request) => runnersOf(context, (await requireUser(context, request)).id),
    );

    app.post(
      "/api/runners",
      {
        schema: {
          tags: ["Runs"],
          summary: "Set up a Runner of your own",
          description:
            "Refused with `unknown_runner_kind` for a kind of Runner this Cronk doesn't have. A `managed_agents` Runner " +
            "takes an Anthropic API key, stored encrypted and never returned: Cronk creates an agent definition (its MCP " +
            "server, tools allowed without asking) and a cloud environment with it in the key's Anthropic workspace, " +
            "and is refused with `api_key_rejected` when Anthropic rejects the key, with `api_key_required` without one, " +
            "and with `no_secret_key` while Cronk has no `CRONK_SECRET_KEY`.",
          body: Type.Object({
            name: Type.String({ minLength: 1, maxLength: 100, pattern: "\\S" }),
            kind: Type.String({ minLength: 1, maxLength: 50 }),
            apiKey: Type.Optional(
              Type.String({ maxLength: 1000, description: "For a `managed_agents` Runner: the Anthropic API key its Runs spend." }),
            ),
          }),
          response: { 201: RunnerRecord, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 502: ErrorBody },
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
          summary: "Set your Runner's limit on Runs at once or its budget per Run",
          description:
            "Changes what the body names. Tickets needing a Run beyond the limit wait for a slot, highest Priority " +
            "first, then the one that entered its Status first. Raising the limit starts waiting Tickets at once; " +
            "lowering it stops no running Run. A `managed_agents` Runner's budget per Run applies to Runs started from " +
            "then on; other kinds are refused one with `runner_has_no_budget`.",
          params: Type.Object({ runnerId: Type.String() }),
          body: Type.Object(
            { limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), budgetPerRun: Type.Optional(BudgetPerRun) },
            { minProperties: 1 },
          ),
          response: { 200: RunnerRecord, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        return updateRunner(context, user.id, request.params.runnerId, request.body);
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
            "A `managed_agents` Runner's running Runs stop, their sessions interrupted and archived and their tokens " +
            "revoked; other kinds are refused with `runner_running` while one of their Runs is running.",
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
            "encrypted and never returned. Without a token, the trigger keeps the token it has under the same trigger " +
            "id, or else waits for one (`waitingForToken`): Runs needing it can't start until it is pasted. Refused " +
            "with `runner_has_no_triggers` for other kinds of Runner, and with `no_secret_key`, when it has a token, " +
            "while Cronk has no `CRONK_SECRET_KEY`.",
          params: Type.Object({ runnerId: Type.String() }),
          body: Type.Object({
            model: ModelLabel,
            projectId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
            triggerId: Type.String({ minLength: 1, maxLength: 200, pattern: "^\\s*[A-Za-z0-9_-]+\\s*$" }),
            token: Type.Optional(
              Type.String({
                minLength: 1,
                maxLength: 1000,
                pattern: "\\S",
                description: "The trigger's token; leave it out to save the trigger waiting for it.",
              }),
            ),
          }),
          response: { 200: RunnerRecord, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        return saveTrigger(context, user.id, request.params.runnerId, request.body);
      },
    );

    app.post(
      "/api/runners/:runnerId/setups",
      {
        schema: {
          tags: ["Runs"],
          summary: "Set up a Project's routines with Claude Code",
          description:
            "Starts a Runner setup of your `subscription` Runner for a Project you can see: plans one claude.ai routine " +
            "per model label the Project's board uses, with the model id the Workspace maps it to, and returns the " +
            "command to paste into your own Claude Code, which creates them and reports their trigger ids back. The " +
            "command works once, for an hour. The Agent, pointed at the Runner in the Project's Workspace, is the one " +
            "whose new *Transcript hook* token the instructions hand over; it may be left out when there is only one. " +
            "Users only.",
          params: Type.Object({ runnerId: Type.String() }),
          body: Type.Object({
            projectId: Type.String({ format: "uuid" }),
            agentId: Type.Optional(Type.String({ format: "uuid" })),
          }),
          response: { 201: StartedSetup, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request, reply) => {
        const user = await requireUser(context, request);
        return reply.code(201).send(await startSetup(context, user.id, request.params.runnerId, request.body));
      },
    );

    // The command's `curl -f` fetches these as the User's prompt for Claude Code; a refusal is plain text, so it fails.
    app.get(instructionsPath, { schema: { hide: true, params: Type.Object({ setupToken: Type.String() }) } }, async (request, reply) => {
      reply.header("cache-control", "no-store");
      try {
        const text = await setupInstructions(context, request.params.setupToken);
        return reply.type("text/markdown; charset=utf-8").send(text);
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        return reply.code(error.statusCode).type("text/plain; charset=utf-8").send(`${error.message}\n`);
      }
    });

    app.post(
      "/api/runner-setups/:setupToken/triggers",
      {
        schema: {
          tags: ["Runs"],
          summary: "Report a Runner setup's routines back",
          description:
            "Called by the User's Claude Code, authenticated only by the setup token its instructions hold: the trigger id " +
            "of the routine it created for each of the setup's model labels, all in one call. Each becomes the Project's " +
            "trigger for its label on the Runner, waiting for its token, replacing the Project's earlier triggers; " +
            "triggers for all Projects stay. Marks the setup used. Refused with `setup_used`, `setup_expired` or " +
            "`setup_not_found` (press Set up with Claude Code again), and to Agents.",
          params: Type.Object({ setupToken: Type.String() }),
          body: Type.Object({
            triggers: Type.Array(
              Type.Object({
                label: Type.String({ minLength: 1, maxLength: 50, pattern: "\\S", description: "The model label, as the plan names it." }),
                triggerId: Type.String({ minLength: 1, maxLength: 200, pattern: "^\\s*[A-Za-z0-9_-]+\\s*$" }),
              }),
              { maxItems: 50 },
            ),
          }),
          response: {
            200: Type.Object({ triggers: Type.Array(Trigger) }),
            400: ErrorBody,
            403: ErrorBody,
            404: ErrorBody,
            410: ErrorBody,
          },
        },
      },
      async (request) => {
        const agent = await authenticateAgent(context, request);
        if (agent) {
          throw new ApiError(403, "agent_not_allowed", `${agent.name} is an Agent, and only a User's Claude Code completes a Runner setup.`);
        }
        return reportSetup(context, request.params.setupToken, request.body);
      },
    );

    app.put(
      "/api/runners/:runnerId/triggers/:triggerId/token",
      {
        schema: {
          tags: ["Runs"],
          summary: "Paste the token of a trigger of your subscription Runner",
          description:
            "For a trigger waiting for its token (`waitingForToken`), as one saved without it or made by a Runner setup " +
            "is: the API token generated for its routine in claude.ai, which makes it usable; for a working one, its new " +
            "token. Generating a new token in claude.ai revokes the routine's previous one. The token is stored encrypted " +
            "and never returned. Pasted into a waiting trigger, the Tickets whose Runs couldn't start for want of it are " +
            "rechecked, so they start or wait for a slot; otherwise they wait for Retry. Refused with `no_secret_key` " +
            "while Cronk has no `CRONK_SECRET_KEY`.",
          params: Type.Object({ runnerId: Type.String(), triggerId: Type.String() }),
          body: Type.Object({ token: Type.String({ minLength: 1, maxLength: 1000, pattern: "\\S" }) }),
          response: { 200: RunnerRecord, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        return pasteTriggerToken(context, user.id, request.params.runnerId, request.params.triggerId, request.body.token);
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

    app.put(
      "/api/runners/:runnerId/webhook-secret",
      {
        schema: {
          tags: ["Runs"],
          summary: "Save the webhook signing secret of your Managed Agents Runner",
          description:
            "The `whsec_` signing secret the Anthropic Console shows once for the webhook endpoint you added there at the " +
            "Runner's `webhookUrl`, subscribed to `session.status_idled` and `session.status_terminated`. Signed " +
            "deliveries then end Runs whose sessions stopped at once; polling stays as the backstop. Stored encrypted and " +
            "never returned; saving again replaces it, as after rotating it in the Console. Only its format is checked: " +
            "deliveries signed with another secret are refused, and the Console disables an endpoint that keeps failing. Refused with " +
            "`invalid_webhook_secret` for one not starting `whsec_`, with `runner_has_no_webhook` for other kinds of " +
            "Runner, and with `no_secret_key` while Cronk has no `CRONK_SECRET_KEY`.",
          params: Type.Object({ runnerId: Type.String() }),
          body: Type.Object({ secret: Type.String({ minLength: 1, maxLength: 200 }) }),
          response: { 200: RunnerRecord, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        return saveWebhookSecret(context, user.id, request.params.runnerId, request.body.secret);
      },
    );

    app.delete(
      "/api/runners/:runnerId/webhook-secret",
      {
        schema: {
          tags: ["Runs"],
          summary: "Forget the webhook signing secret of your Managed Agents Runner",
          description:
            "Deliveries are then refused, and Runs whose sessions stopped end by polling alone. Remove the endpoint in the " +
            "Anthropic Console too: refused deliveries count as failures, and the Console disables an endpoint that keeps failing.",
          params: Type.Object({ runnerId: Type.String() }),
          response: { 200: RunnerRecord, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        return forgetWebhookSecret(context, user.id, request.params.runnerId);
      },
    );

    const reports = runReports(context);
    await deliveryRoute(
      app,
      managedAgentsWebhookPath,
      {
        bodyLimit: webhookBodyLimit,
        schema: {
          tags: ["Runs"],
          summary: "Where Anthropic sends a Managed Agents Runner's webhook deliveries",
          description:
            "For Anthropic only. A delivery must carry the `webhook-id`, `webhook-timestamp` and `webhook-signature` " +
            "headers, signed with the Runner's saved signing secret within five minutes of now, or it is refused with " +
            "`invalid_signature` before anything else is looked at, as is every delivery to a Runner without one. A " +
            "`session.status_idled` or `session.status_terminated` about the session of one of the Runner's running " +
            "Runs reads that session and ends the Run as polling would; `ended` says whether it did. Refused with " +
            "`anthropic_unavailable` when Anthropic can't answer about the session now, so it sends the delivery again. " +
            "Anything else, a repeated delivery included, changes nothing.",
          params: Type.Object({ runnerId: Type.String() }),
          response: { 200: Type.Object({ ended: Type.Boolean() }), 400: ErrorBody, 401: ErrorBody, 502: ErrorBody },
        },
      },
      async ({ body, header, params }) => {
        const ended = await receiveManagedAgentsDelivery(context, reports, params.runnerId!, body, {
          id: header("webhook-id"),
          timestamp: header("webhook-timestamp"),
          signature: header("webhook-signature"),
        });
        return { ended };
      },
    );
  };
}

/** Anthropic's thin webhook payloads name an event and a resource; a megabyte is far more than one takes. */
const webhookBodyLimit = 1024 * 1024;
