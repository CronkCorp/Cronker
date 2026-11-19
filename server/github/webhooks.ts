import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context } from "../context.js";
import { transaction, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { appToken, findApp, webhookSecret } from "./app.js";
import { appDeliveries, redeliver } from "./client.js";
import { onCheckRunEvent, onPullRequestEvent, onPullRequestReviewEvent, onStatusEvent } from "./pull-requests.js";
import { onRepositoryEvent } from "./repositories.js";

/**
 * The App's webhook deliveries. Each is checked against the App's webhook secret before
 * anything else is done with it, then applied once: its delivery id is recorded in the same
 * transaction that applies it, so a delivery GitHub sends again changes nothing. The id isn't
 * signed, so handlers must still change nothing for a signed body seen before under another.
 * A failed delivery is asked for again by `replayFailedDeliveries`.
 */

export interface Delivery {
  id: string;
  event: string;
  payload: unknown;
}

/** What a delivery of one event does, inside the transaction that records it. */
export type EventHandler = (context: Context, tx: Tx, delivery: Delivery) => Promise<void>;

/** Handlers by event name. Events with none, such as `ping`, are recorded and otherwise ignored. */
const handlers: Record<string, EventHandler> = {
  repository: onRepositoryEvent,
  pull_request: onPullRequestEvent,
  pull_request_review: onPullRequestReviewEvent,
  check_run: onCheckRunEvent,
  status: onStatusEvent,
};

const invalidSignature = () =>
  new ApiError(401, "invalid_signature", "The delivery isn't signed with the GitHub App's webhook secret.");

/** Whether `X-Hub-Signature-256` is the body's HMAC under the App's webhook secret. */
async function isSigned(context: Context, body: Buffer, signature: string | undefined): Promise<boolean> {
  const given = /^sha256=([0-9a-f]{64})$/.exec(signature ?? "")?.[1];
  if (!given) return false;
  const stored = await webhookSecret(context);
  if (!stored) return false;
  const expected = createHmac("sha256", stored.secret).update(body).digest();
  if (!timingSafeEqual(expected, Buffer.from(given, "hex"))) return false;
  if (!stored.confirmed) {
    await context.db.query("update github_app set webhook_secret_confirmed_at = $1 where webhook_secret_confirmed_at is null", [
      context.clock.now(),
    ]);
  }
  return true;
}

/** A delivery's payload: its JSON body, or, for an App set to send forms, the JSON in its `payload` field. */
function payloadOf(body: Buffer, contentType: string | undefined): unknown {
  const text = body.toString("utf8");
  const json = contentType?.startsWith("application/x-www-form-urlencoded") ? new URLSearchParams(text).get("payload") ?? "" : text;
  try {
    return JSON.parse(json);
  } catch {
    throw new ApiError(400, "invalid_request", "A delivery's body must be JSON, or a form with JSON in its `payload` field.");
  }
}

/**
 * Checks a delivery's signature, then applies it unless it was applied before. Returns
 * whether this call applied it.
 */
export async function receiveDelivery(
  context: Context,
  body: Buffer,
  headers: { signature?: string; event?: string; id?: string; contentType?: string },
): Promise<boolean> {
  if (!(await isSigned(context, body, headers.signature))) throw invalidSignature();
  const { event, id } = headers;
  if (!event || !id) throw new ApiError(400, "invalid_request", "A delivery names its event and its delivery id.");
  const payload = payloadOf(body, headers.contentType);
  return transaction(context.db, async (tx) => {
    const { rowCount } = await tx.query(
      "insert into github_deliveries (id, event, applied_at) values ($1, $2, $3) on conflict do nothing",
      [id, event, context.clock.now()],
    );
    if (rowCount === 0) return false;
    await handlers[event]?.(context, tx, { id, event, payload });
    return true;
  });
}

/**
 * GitHub doesn't retry a delivery that failed, so one sent while Cronk or its tunnel was down
 * would be missed. This asks GitHub for the App's recent deliveries and has each failed one
 * redelivered. GitHub keeps deliveries three days; nothing replays a longer outage. A delivery
 * Cronk refused, such as one signed before its webhook secret was pasted into the App's
 * settings, isn't applied, so it is asked for again on each pass until it applies or GitHub
 * drops it.
 */
export async function replayFailedDeliveries(context: Context): Promise<void> {
  if (!(await findApp(context.db))) return;
  const jwt = await appToken(context);
  const failed = (await appDeliveries(context.config, jwt)).filter((a) => a.status_code < 200 || a.status_code >= 300);
  if (failed.length === 0) return;
  const { rows } = await context.db.query<{ id: string }>("select id from github_deliveries where id = any($1)", [
    failed.map((a) => a.guid),
  ]);
  // Deliveries applied, or asked for again in this pass: a delivery has an attempt for each time GitHub sent it.
  const done = new Set(rows.map((r) => r.id));
  // One redelivery GitHub refuses, such as of a delivery it stopped keeping since listing it, doesn't stop the rest.
  let refused: unknown;
  for (const attempt of failed) {
    if (done.has(attempt.guid)) continue;
    done.add(attempt.guid);
    await redeliver(context.config, jwt, attempt.id).catch((error: unknown) => {
      refused ??= error;
    });
  }
  if (refused) throw refused;
}
