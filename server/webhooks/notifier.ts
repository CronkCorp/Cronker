import type { Context } from "../context.js";
import { inboxOf, type InboxItem } from "../inbox/inbox.js";
import type { LiveEvent } from "../live/live.js";
import { queueDelivery, type WebhookKind } from "./webhooks.js";

/**
 * The notifier: sends what lands in a User's Inbox to their webhooks that chose its kind, once. The Inbox isn't stored,
 * so on each change that can make an item appear it reads the Inbox of every User with a webhook in that Workspace and
 * compares it with the items each webhook has already heard of. Only a User's own Inbox reaches their webhooks, with
 * the Access it gives them.
 */

/** The events after which an Inbox in their Workspace may have gained an item. */
const inboxEvents = new Set<LiveEvent["type"]>([
  "ticket.created",
  "ticket.changed",
  "comment.added",
  "project.changed",
  "project.gained",
  "statuses.changed",
]);

/**
 * What identifies an Inbox item: its kind and its source. An item that comes from a state a Ticket can enter again,
 * such as a Review Status, includes when it entered it, so entering it again is a new item.
 */
export function inboxItemKey(item: InboxItem): string {
  switch (item.kind) {
    case "question":
      return `question:${item.question.id}`;
    case "run":
      return `run:${item.run.id}`;
    case "discovered":
      return `discovered:${item.ticket.id}`;
    default:
      return `${item.kind}:${item.ticket.id}:${item.since}`;
  }
}

interface WebhookRow {
  id: string;
  userId: string;
  isAdmin: boolean;
  kinds: WebhookKind[];
  enabled: boolean;
  createdAt: Date;
  slug: string;
}

/**
 * One pass over a Workspace: queues a delivery for each item in a webhook owner's Inbox that the webhook hasn't heard
 * of, is on, chose the kind of, and that began waiting no earlier than the webhook was added. Every item is recorded as
 * heard of, sent or not, so turning a webhook on or choosing more kinds doesn't send what was already waiting. Nothing
 * of an archived Project is sent, and on unarchiving what waited from before it is recorded without being sent.
 */
export async function notifyWorkspace(context: Context, workspaceId: string): Promise<void> {
  const { db, clock, config } = context;
  const { rows: webhooks } = await db.query<WebhookRow>(
    `select webhooks.id, webhooks.user_id as "userId", memberships.is_admin as "isAdmin", webhooks.kinds,
       webhooks.enabled, webhooks.created_at as "createdAt", workspaces.slug
     from webhooks join memberships on memberships.workspace_id = webhooks.workspace_id and memberships.user_id = webhooks.user_id
     join workspaces on workspaces.id = webhooks.workspace_id
     where webhooks.workspace_id = $1 order by webhooks.created_at, webhooks.id`,
    [workspaceId],
  );
  const byUser = new Map<string, WebhookRow[]>();
  for (const webhook of webhooks) byUser.set(webhook.userId, [...(byUser.get(webhook.userId) ?? []), webhook]);
  if (byUser.size === 0) return;
  // An archived Project's items are out of the Inbox, so none is sent; those that waited from before it was unarchived
  // are old news once it is, so they are recorded as heard of without being sent.
  const { rows: unarchived } = await db.query<{ id: string; unarchivedAt: Date }>(
    `select id, unarchived_at as "unarchivedAt" from projects where workspace_id = $1 and unarchived_at is not null`,
    [workspaceId],
  );
  const unarchivedAt = new Map(unarchived.map((p) => [p.id, p.unarchivedAt.getTime()]));
  for (const [userId, own] of byUser) {
    const { items } = await inboxOf(db, userId, { id: workspaceId, isAdmin: own[0]!.isAdmin });
    for (const item of items) {
      const key = inboxItemKey(item);
      const since = Date.parse(item.since);
      const fromBeforeUnarchiving = since < (unarchivedAt.get(item.ticket.projectId) ?? -Infinity);
      for (const webhook of own) {
        if (since < webhook.createdAt.getTime()) continue;
        const { rowCount } = await db.query(
          "insert into webhook_inbox_seen (webhook_id, item_key) values ($1, $2) on conflict do nothing",
          [webhook.id, key],
        );
        if (!rowCount || fromBeforeUnarchiving || !webhook.enabled || !webhook.kinds.includes(item.kind)) continue;
        const url = new URL(`/${webhook.slug}/tickets/${item.ticket.key}`, config.publicUrl).href;
        // Never the Ticket's description or Comments: a receiver such as ntfy may be public.
        await queueDelivery(
          db,
          webhook.id,
          {
            kind: item.kind,
            workspace: webhook.slug,
            ticket: { key: item.ticket.key, title: item.ticket.title, url },
            ...(item.kind === "run" ? { run: item.run.id } : {}),
            at: item.since,
          },
          clock.now(),
        );
      }
    }
  }
}

/**
 * Runs `notifyWorkspace` after each change that may add an Inbox item, one pass at a time: changes made while a pass
 * runs are gathered into the next, so a burst of them costs one more pass per Workspace.
 */
export class InboxNotifier {
  private readonly dirty = new Set<string>();
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly context: Context,
    private readonly onError: (error: unknown) => void,
  ) {}

  /** Starts listening on the Workspaces' event bus, and catches up on every Workspace with a webhook that is on. */
  async start(): Promise<void> {
    this.context.live.listen((workspaceId, event) => {
      if (inboxEvents.has(event.type)) this.touch(workspaceId);
    });
    // Changes made while the server was down, or by a server command, published nothing here.
    const { rows } = await this.context.db.query<{ workspaceId: string }>(
      `select distinct workspace_id as "workspaceId" from webhooks where enabled`,
    );
    for (const { workspaceId } of rows) this.touch(workspaceId);
  }

  /** Has the Workspace's Inboxes checked soon. */
  touch(workspaceId: string): void {
    if (this.stopped) return;
    this.dirty.add(workspaceId);
    this.running ??= this.drain().finally(() => {
      this.running = null;
    });
  }

  private async drain(): Promise<void> {
    // Let the rest of the request's changes commit first, so they share the pass.
    await new Promise((resolve) => setImmediate(resolve));
    while (this.dirty.size > 0 && !this.stopped) {
      const workspaces = [...this.dirty];
      this.dirty.clear();
      for (const workspaceId of workspaces) {
        if (this.stopped) return;
        await notifyWorkspace(this.context, workspaceId).catch(this.onError);
      }
    }
  }

  /** Resolves once no pass is running or waiting. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  /** Stops passes from starting, and waits for the one running. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.idle();
  }
}
