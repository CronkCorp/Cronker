import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { ErrorBody } from "../http/errors.js";
import { requireUser } from "../identity/sign-ins.js";
import { requireMember } from "../workspaces/members.js";
import {
  CreatedWebhook,
  createWebhook,
  deliveriesOf,
  editWebhook,
  findWebhook,
  removeWebhook,
  sendTest,
  Webhook,
  WebhookDelivery,
  WebhookKind,
  WebhookName,
  webhooksOf,
  WebhookUrl,
} from "./webhooks.js";

const only =
  "Only the signed-in User's own webhooks in the Workspace; Agents are refused with `agent_not_allowed`, and never see webhooks.";

export function webhookRoutes(context: Context): FastifyPluginAsyncTypebox {
  const { db } = context;
  const WorkspaceParams = Type.Object({ workspaceId: Type.String() });
  const WebhookParams = Type.Object({ workspaceId: Type.String(), webhookId: Type.String() });
  const responses = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };

  return async (app) => {
    app.get(
      "/api/workspaces/:workspaceId/webhooks",
      {
        schema: {
          tags: ["Webhooks"],
          summary: "The signed-in User's webhooks in a Workspace",
          description: `${only} Their secrets are never listed.`,
          params: WorkspaceParams,
          response: { 200: Type.Array(Webhook), ...responses },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        const workspace = await requireMember(db, user.id, request.params.workspaceId);
        return webhooksOf(db, user.id, workspace.id);
      },
    );

    app.post(
      "/api/workspaces/:workspaceId/webhooks",
      {
        schema: {
          tags: ["Webhooks"],
          summary: "Add a webhook",
          description:
            `${only} The URL must use https, or plain http to localhost on a local Cronk (\`invalid_webhook_url\` otherwise). ` +
            "Kinds default to `question`, `needsYou` and `run` (failed, lost and unstarted Runs). The answer carries the " +
            "signing secret, which is shown only this once; Cronk keeps it encrypted, so it needs `CRONK_SECRET_KEY` (`no_secret_key` otherwise).",
          params: WorkspaceParams,
          body: Type.Object({
            name: WebhookName,
            url: WebhookUrl,
            kinds: Type.Optional(Type.Array(WebhookKind)),
            enabled: Type.Optional(Type.Boolean()),
          }),
          response: { 201: CreatedWebhook, ...responses },
        },
      },
      async (request, reply) => {
        const user = await requireUser(context, request);
        const workspace = await requireMember(db, user.id, request.params.workspaceId);
        return reply.code(201).send(await createWebhook(context, user.id, workspace.id, request.body));
      },
    );

    app.get(
      "/api/workspaces/:workspaceId/webhooks/:webhookId",
      {
        schema: {
          tags: ["Webhooks"],
          summary: "One of the signed-in User's webhooks",
          description: `${only} Its secret is never shown again.`,
          params: WebhookParams,
          response: { 200: Webhook, ...responses },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        const workspace = await requireMember(db, user.id, request.params.workspaceId);
        return findWebhook(db, user.id, workspace.id, request.params.webhookId);
      },
    );

    app.patch(
      "/api/workspaces/:workspaceId/webhooks/:webhookId",
      {
        schema: {
          tags: ["Webhooks"],
          summary: "Edit a webhook",
          description: `${only} Changes whichever of name, URL, kinds and on or off are given; the URL by the same rule as when added.`,
          params: WebhookParams,
          body: Type.Object({
            name: Type.Optional(WebhookName),
            url: Type.Optional(WebhookUrl),
            kinds: Type.Optional(Type.Array(WebhookKind)),
            enabled: Type.Optional(Type.Boolean()),
          }),
          response: { 200: Webhook, ...responses },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        const workspace = await requireMember(db, user.id, request.params.workspaceId);
        return editWebhook(context, user.id, workspace.id, request.params.webhookId, request.body);
      },
    );

    app.delete(
      "/api/workspaces/:workspaceId/webhooks/:webhookId",
      {
        schema: {
          tags: ["Webhooks"],
          summary: "Remove a webhook",
          description: `${only} Its deliveries go with it, sent or not.`,
          params: WebhookParams,
          response: { 204: Type.Null(), ...responses },
        },
      },
      async (request, reply) => {
        const user = await requireUser(context, request);
        const workspace = await requireMember(db, user.id, request.params.workspaceId);
        await removeWebhook(db, user.id, workspace.id, request.params.webhookId);
        return reply.code(204).send(null);
      },
    );

    app.post(
      "/api/workspaces/:workspaceId/webhooks/:webhookId/test",
      {
        schema: {
          tags: ["Webhooks"],
          summary: "Send a test delivery",
          description:
            `${only} Queues a delivery of kind \`test\` about a made-up Ticket, \`TEST-1\`, which the delivery check sends within a few seconds, ` +
            "whether the webhook is on or off. Returns it, pending.",
          params: WebhookParams,
          response: { 201: WebhookDelivery, ...responses },
        },
      },
      async (request, reply) => {
        const user = await requireUser(context, request);
        const { isAdmin: _, ...workspace } = await requireMember(db, user.id, request.params.workspaceId);
        return reply.code(201).send(await sendTest(context, user.id, workspace, request.params.webhookId));
      },
    );

    app.get(
      "/api/workspaces/:workspaceId/webhooks/:webhookId/deliveries",
      {
        schema: {
          tags: ["Webhooks"],
          summary: "A webhook's last deliveries",
          description: `${only} Its last 20 deliveries, newest first, each with every try's status code and time. A failed try is retried with backoff from 30 seconds, doubling, for about 24 hours; then the delivery is \`failed\` and the webhook \`failing\` until a delivery succeeds.`,
          params: WebhookParams,
          response: { 200: Type.Array(WebhookDelivery), ...responses },
        },
      },
      async (request) => {
        const user = await requireUser(context, request);
        const workspace = await requireMember(db, user.id, request.params.workspaceId);
        return deliveriesOf(db, user.id, workspace.id, request.params.webhookId);
      },
    );
  };
}
