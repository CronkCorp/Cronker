import { createHmac, randomBytes } from "node:crypto";
import { Type, type Static } from "typebox";
import type { Config } from "../config.js";
import type { Context } from "../context.js";
import type { Db, Tx } from "../db.js";
import { requireSecretBox } from "../encryption.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import { literals } from "../literals.js";
import type { Workspace } from "../workspaces/workspaces.js";

/**
 * Webhooks: a User's own channels for what waits in their Inbox in a Workspace. Each gets the Inbox kinds it chose,
 * as signed JSON deliveries laid out like Standard Webhooks (https://www.standardwebhooks.com), so existing verifiers
 * work. Deliveries are kept in Postgres and sent by a check the server runs every few seconds; only the last 20 per
 * webhook are kept. Webhooks are for Users alone: Agents never see or change them.
 */

/** The Inbox kinds a webhook may get. */
export const webhookKinds = ["question", "needsYou", "run", "review", "unverified", "discovered", "reassign"] as const;
export const WebhookKind = literals(webhookKinds);
export type WebhookKind = (typeof webhookKinds)[number];

/** What a new webhook gets unless told otherwise: where work has stalled. `run` covers failed, lost and unstarted Runs. */
export const defaultWebhookKinds: WebhookKind[] = ["question", "needsYou", "run"];

/** How many deliveries are kept per webhook, the newest. */
export const keptDeliveries = 20;

/** How long a receiver has to answer a delivery. */
const deliveryTimeoutMs = 10_000;

export const WebhookName = Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" });
export const WebhookUrl = Type.String({ minLength: 1, maxLength: 2000 });

/** The create route's body: a name, the address to deliver to, and the Inbox kinds it gets, the defaults if left out. */
export const WebhookCreate = Type.Object({
  name: WebhookName,
  url: WebhookUrl,
  kinds: Type.Optional(Type.Array(WebhookKind)),
  enabled: Type.Optional(Type.Boolean()),
});
export type WebhookCreate = Static<typeof WebhookCreate>;

/** The edit route's body: whichever of a webhook's name, address, kinds and whether it is enabled change. */
export const WebhookEdit = Type.Object({
  name: Type.Optional(WebhookName),
  url: Type.Optional(WebhookUrl),
  kinds: Type.Optional(Type.Array(WebhookKind)),
  enabled: Type.Optional(Type.Boolean()),
});
export type WebhookEdit = Static<typeof WebhookEdit>;

export const Webhook = Type.Object({
  id: Type.String({ format: "uuid" }),
  workspaceId: Type.String({ format: "uuid" }),
  name: Type.String(),
  url: Type.String(),
  kinds: Type.Array(WebhookKind),
  enabled: Type.Boolean(),
  createdAt: Type.String({ format: "date-time" }),
});
export type Webhook = Static<typeof Webhook>;

export const CreatedWebhook = Type.Intersect([
  Webhook,
  Type.Object({
    secret: Type.String({
      description: "The signing secret, `whsec_` and 32 random bytes in base64, as Standard Webhooks has it. Shown only now.",
    }),
  }),
]);

export const WebhookDelivery = Type.Object({
  id: Type.String({ format: "uuid" }),
  kind: Type.String(),
  createdAt: Type.String({ format: "date-time" }),
  state: Type.Union([Type.Literal("pending"), Type.Literal("delivered"), Type.Literal("failed")], {
    description: "Pending until sent; delivered when the receiver answered 2xx; failed otherwise.",
  }),
  statusCode: Type.Union([Type.Integer(), Type.Null()], { description: "The receiver's answer, or null when it gave none." }),
  error: Type.Union([Type.String(), Type.Null()], { description: "Why there was no answer, such as a timeout." }),
  sentAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
});
export type WebhookDelivery = Static<typeof WebhookDelivery>;

const columns = `id, workspace_id as "workspaceId", name, url, kinds, enabled, created_at as "createdAt"`;

interface WebhookRow extends Omit<Webhook, "createdAt"> {
  createdAt: Date;
}

const present = (row: WebhookRow): Webhook => ({ ...row, createdAt: row.createdAt.toISOString() });

const notFound = () => new ApiError(404, "not_found", "No such webhook.");

const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A webhook's URL must be `https`, so deliveries aren't sent in the clear; plain `http` only to a local address, and
 * only on a local Cronk (one whose own public address is plain http to localhost).
 */
export function checkWebhookUrl(config: Config, value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ApiError(400, "invalid_webhook_url", "A webhook's URL must be an absolute URL, such as https://ntfy.sh/my-topic.");
  }
  if (url.username || url.password) {
    throw new ApiError(400, "invalid_webhook_url", "A webhook's URL can't carry a user name or password.");
  }
  if (url.protocol === "https:") return url.href;
  const localCronk = config.publicUrl.protocol === "http:" && localHosts.has(config.publicUrl.hostname);
  if (url.protocol === "http:" && localCronk && localHosts.has(url.hostname)) return url.href;
  throw new ApiError(
    400,
    "invalid_webhook_url",
    localCronk
      ? "A webhook's URL must use https, or plain http to localhost."
      : "A webhook's URL must use https, so deliveries aren't sent in the clear.",
  );
}

function checkKinds(kinds: string[]): WebhookKind[] {
  const unique = [...new Set(kinds)] as WebhookKind[];
  if (unique.length === 0) throw new ApiError(400, "no_webhook_kinds", "A webhook needs at least one Inbox kind to get.");
  return unique;
}

/** The User's webhooks in the Workspace, by name. */
export async function webhooksOf(db: Db, userId: string, workspaceId: string): Promise<Webhook[]> {
  const { rows } = await db.query<WebhookRow>(
    `select ${columns} from webhooks where workspace_id = $1 and user_id = $2 order by lower(name), created_at, id`,
    [workspaceId, userId],
  );
  return rows.map(present);
}

async function findOwn(db: Db, userId: string, workspaceId: string, webhookId: string): Promise<WebhookRow> {
  if (!isUuid(webhookId)) throw notFound();
  const { rows } = await db.query<WebhookRow>(
    `select ${columns} from webhooks where id = $1 and workspace_id = $2 and user_id = $3`,
    [webhookId, workspaceId, userId],
  );
  if (!rows[0]) throw notFound();
  return rows[0];
}

export async function findWebhook(db: Db, userId: string, workspaceId: string, webhookId: string): Promise<Webhook> {
  return present(await findOwn(db, userId, workspaceId, webhookId));
}

/** Adds a webhook, returning its signing secret this once; it is kept sealed under `CRONK_SECRET_KEY`. */
export async function createWebhook(
  { db, clock, config }: Context,
  userId: string,
  workspaceId: string,
  input: WebhookCreate,
): Promise<Webhook & { secret: string }> {
  const url = checkWebhookUrl(config, input.url);
  const kinds = checkKinds(input.kinds ?? defaultWebhookKinds);
  const box = requireSecretBox(config);
  const secret = `whsec_${randomBytes(32).toString("base64")}`;
  const { rows } = await db.query<WebhookRow>(
    `insert into webhooks (workspace_id, user_id, name, url, kinds, enabled, secret_sealed, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning ${columns}`,
    [workspaceId, userId, input.name.trim(), url, kinds, input.enabled ?? true, box.seal(secret), clock.now()],
  );
  return { ...present(rows[0]!), secret };
}

/** Changes whichever of a webhook's name, URL, kinds and on or off are given. */
export async function editWebhook(
  { db, config }: Context,
  userId: string,
  workspaceId: string,
  webhookId: string,
  input: WebhookEdit,
): Promise<Webhook> {
  const current = await findOwn(db, userId, workspaceId, webhookId);
  const url = input.url === undefined ? current.url : checkWebhookUrl(config, input.url);
  const kinds = input.kinds === undefined ? current.kinds : checkKinds(input.kinds);
  const { rows } = await db.query<WebhookRow>(
    `update webhooks set name = $2, url = $3, kinds = $4, enabled = $5 where id = $1 returning ${columns}`,
    [current.id, input.name?.trim() ?? current.name, url, kinds, input.enabled ?? current.enabled],
  );
  return present(rows[0]!);
}

/** Removes a webhook with its deliveries, sent or not. */
export async function removeWebhook(db: Db, userId: string, workspaceId: string, webhookId: string): Promise<void> {
  const current = await findOwn(db, userId, workspaceId, webhookId);
  await db.query("delete from webhooks where id = $1", [current.id]);
}

/** The body of a delivery: never a Ticket's description or Comments. */
export interface DeliveryBody {
  id: string;
  kind: WebhookKind | "test";
  workspace: string;
  ticket: { key: string; title: string; url: string };
  run?: string;
  at: string;
}

/**
 * Queues a delivery for the next delivery check. The body's `id` is the delivery's, which its `webhook-id` header
 * repeats.
 */
export async function queueDelivery(
  db: Db,
  webhookId: string,
  content: Omit<DeliveryBody, "id">,
  now: Date,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>("select gen_random_uuid() as id");
  const id = rows[0]!.id;
  const body: DeliveryBody = { id, ...content };
  await db.query(
    `insert into webhook_deliveries (id, webhook_id, kind, body, next_at, created_at) values ($1, $2, $3, $4, $5, $5)`,
    [id, webhookId, content.kind, JSON.stringify(body), now],
  );
  return id;
}

/**
 * Queues a test delivery to one of the User's webhooks, whether on or off. Its Ticket is a made-up sample, so no
 * real Ticket is needed or shown; its URL is the Workspace's.
 */
export async function sendTest(context: Context, userId: string, workspace: Workspace, webhookId: string): Promise<WebhookDelivery> {
  const webhook = await findOwn(context.db, userId, workspace.id, webhookId);
  const now = context.clock.now();
  const id = await queueDelivery(
    context.db,
    webhook.id,
    {
      kind: "test",
      workspace: workspace.slug,
      ticket: { key: "TEST-1", title: "Test delivery", url: new URL(`/${workspace.slug}`, context.config.publicUrl).href },
      at: now.toISOString(),
    },
    now,
  );
  await pruneDeliveries(context.db, webhook.id);
  return (await deliveriesOf(context.db, userId, workspace.id, webhook.id)).find((d) => d.id === id)!;
}

interface DeliveryRow {
  id: string;
  kind: string;
  createdAt: Date;
  statusCode: number | null;
  error: string | null;
  sentAt: Date | null;
}

/** A webhook's kept deliveries, newest first. */
export async function deliveriesOf(db: Db, userId: string, workspaceId: string, webhookId: string): Promise<WebhookDelivery[]> {
  const webhook = await findOwn(db, userId, workspaceId, webhookId);
  const { rows } = await db.query<DeliveryRow>(
    `select id, kind, created_at as "createdAt", status_code as "statusCode", error, sent_at as "sentAt"
     from webhook_deliveries where webhook_id = $1 order by created_at desc, id desc limit ${keptDeliveries}`,
    [webhook.id],
  );
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    createdAt: row.createdAt.toISOString(),
    state: !row.sentAt ? "pending" : row.statusCode !== null && row.statusCode >= 200 && row.statusCode < 300 ? "delivered" : "failed",
    statusCode: row.statusCode,
    error: row.error,
    sentAt: row.sentAt?.toISOString() ?? null,
  }));
}

/** Drops a webhook's deliveries beyond the newest `keptDeliveries`. */
async function pruneDeliveries(db: Db, webhookId: string): Promise<void> {
  await db.query(
    `delete from webhook_deliveries where webhook_id = $1 and id not in (
       select id from webhook_deliveries where webhook_id = $1 order by created_at desc, id desc limit ${keptDeliveries})`,
    [webhookId],
  );
}

/**
 * The Standard Webhooks signature of a delivery: `v1,` and the base64 HMAC-SHA256 of `id.timestamp.body`, keyed with
 * the secret's bytes after `whsec_`, decoded from base64. `test/harness/managed-agents.ts` signs the same way.
 */
export function signDelivery(secret: string, id: string, timestamp: string, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

/**
 * The delivery check: sends every due delivery once, recording the receiver's status code (or why there was none)
 * and the time, then keeps only the newest deliveries of each webhook it sent for.
 */
export async function deliverWebhooks(context: Context): Promise<void> {
  const { db, clock, config } = context;
  const { rows } = await db.query<{ id: string; webhookId: string; url: string; body: string; secretSealed: string }>(
    `select d.id, d.webhook_id as "webhookId", w.url, d.body, w.secret_sealed as "secretSealed"
     from webhook_deliveries d join webhooks w on w.id = d.webhook_id
     where d.sent_at is null and d.next_at <= $1 order by d.created_at, d.id limit 100`,
    [clock.now()],
  );
  if (rows.length === 0) return;
  const box = requireSecretBox(config);
  await Promise.all(
    rows.map(async (delivery) => {
      const timestamp = String(Math.floor(clock.now().getTime() / 1000));
      let statusCode: number | null = null;
      let error: string | null = null;
      try {
        const response = await fetch(delivery.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "Cronk-Webhooks",
            "webhook-id": delivery.id,
            "webhook-timestamp": timestamp,
            "webhook-signature": signDelivery(box.open(delivery.secretSealed), delivery.id, timestamp, delivery.body),
          },
          body: delivery.body,
          redirect: "manual",
          signal: AbortSignal.timeout(deliveryTimeoutMs),
        });
        statusCode = response.status;
        await response.body?.cancel().catch(() => {});
      } catch (failure) {
        const name = (failure as Error).name;
        error = name === "TimeoutError" ? "The receiver didn't answer in time." : "The receiver couldn't be reached.";
      }
      await db.query(
        `update webhook_deliveries set attempts = attempts + 1, status_code = $2, error = $3, sent_at = $4, next_at = null
         where id = $1`,
        [delivery.id, statusCode, error, clock.now()],
      );
    }),
  );
  for (const webhookId of new Set(rows.map((r) => r.webhookId))) await pruneDeliveries(db, webhookId);
}

/** Removes a User's webhooks in a Workspace, as when they leave it. */
export async function removeWebhooksOf(db: Db | Tx, userId: string, workspaceId: string): Promise<void> {
  await db.query("delete from webhooks where workspace_id = $1 and user_id = $2", [workspaceId, userId]);
}
