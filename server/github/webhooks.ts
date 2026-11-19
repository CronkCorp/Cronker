import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context } from "../context.js";
import { transaction, type Tx } from "../db.js";
import { requireSecretBox } from "../encryption.js";
import { ApiError } from "../http/errors.js";

/**
 * The App's webhook deliveries. Each is checked against the App's webhook secret before
 * anything else is done with it, then applied once: its delivery id is recorded in the same
 * transaction that applies it, so a delivery GitHub sends again changes nothing.
 */

export interface Delivery {
  id: string;
  event: string;
  payload: unknown;
}

/** What a delivery of one event does, inside the transaction that records it. */
export type EventHandler = (context: Context, tx: Tx, delivery: Delivery) => Promise<void>;

/** Handlers by event name. Events with none, such as `ping`, are recorded and otherwise ignored. */
const handlers: Record<string, EventHandler> = {};

const invalidSignature = () =>
  new ApiError(401, "invalid_signature", "The delivery isn't signed with the GitHub App's webhook secret.");

/** Whether `X-Hub-Signature-256` is the body's HMAC under the App's webhook secret. */
async function isSigned({ db, config }: Context, body: Buffer, signature: string | undefined): Promise<boolean> {
  const given = /^sha256=([0-9a-f]{64})$/.exec(signature ?? "")?.[1];
  if (!given) return false;
  const { rows } = await db.query<{ webhook_secret: string | null }>("select webhook_secret from github_app");
  const sealed = rows[0]?.webhook_secret;
  if (!sealed) return false;
  const expected = createHmac("sha256", requireSecretBox(config).open(sealed)).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(given, "hex"));
}

/**
 * Checks a delivery's signature, then applies it unless it was applied before. Returns
 * whether this call applied it.
 */
export async function receiveDelivery(
  context: Context,
  body: Buffer,
  headers: { signature?: string; event?: string; id?: string },
): Promise<boolean> {
  if (!(await isSigned(context, body, headers.signature))) throw invalidSignature();
  const { event, id } = headers;
  if (!event || !id) throw new ApiError(400, "invalid_request", "A delivery names its event and its delivery id.");
  let payload: unknown;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    throw new ApiError(400, "invalid_request", "A delivery's body must be JSON.");
  }
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
