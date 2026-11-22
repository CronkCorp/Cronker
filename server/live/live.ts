import { afterCommit, beforeCommit, firstInTransaction, type Tx } from "../db.js";
import { readersIn } from "../identity/viewers.js";

/**
 * What a Workspace's event stream tells its clients: which record changed, by id. Clients
 * fetch what they show again through the API, so an event carries no fields of its own.
 */
export type LiveEvent =
  | { type: "project.created"; projectId: string }
  | { type: "project.changed"; projectId: string }
  | { type: "project.gained"; projectId: string }
  | { type: "project.lost"; projectId: string }
  | { type: "statuses.changed"; projectId: string }
  | { type: "ticket.created"; projectId: string; ticketId: string }
  | { type: "ticket.changed"; projectId: string; ticketId: string }
  | { type: "comment.added"; projectId: string; ticketId: string; commentId: string }
  | { type: "report.added"; projectId: string; ticketId: string; reportId: string }
  | { type: "report.changed"; projectId: string; ticketId: string; reportId: string }
  | { type: "attachments.changed"; projectId: string; ticketId: string }
  | { type: "pull_requests.changed"; projectId: string; ticketId: string }
  | { type: "transcripts.changed"; projectId: string; ticketId: string }
  | { type: "attachments.changed"; documentId: string }
  | { type: "document.changed"; projectId: string | null; documentId: string }
  | { type: "term.changed"; projectId: string | null; termId: string }
  | { type: "decision.changed"; projectId: string | null; decisionId: string }
  | { type: "artifact.changed"; projectId: string | null; artifactId: string }
  | { type: "artifact.comments.changed"; projectId: string | null; artifactId: string }
  | { type: "transcript.changed"; transcriptId: string; runId: string | null };

export const liveEventTypes: Record<LiveEvent["type"], string> = {
  "project.created": "A Project was created, with its Statuses.",
  "project.changed": "A Project's settings changed.",
  "project.gained":
    "A change to a Project's Access let you read it, so it now shows, with everything in it; sent only to the Users who gained it.",
  "project.lost":
    "A change to a Project's Access took it away from you, so it and everything in it no longer shows; sent only to the Users who lost it, and the last event about it they get.",
  "statuses.changed": "A Project's Statuses were added, renamed, moved, given another kind or removed, or a Status's Step changed.",
  "ticket.created": "A Ticket was created.",
  "ticket.changed": "A Ticket's fields changed, its Status among them, or its Relations or Sub-Tickets, or one of its Runs started or ended.",
  "comment.added":
    "A Comment was added to a Ticket, or to an Artifact the Ticket links (`artifact.comments.changed` tells the Artifact's page).",
  "report.added": "A Run wrote a Report on a Ticket.",
  "report.changed": "A Report on a Ticket was saved as its next Version, or deleted.",
  "pull_requests.changed": "A Pull Request linked to a Ticket, or one linked to it changed: its title, branch, state, checks or reviews.",
  "transcripts.changed":
    "A session outside a Run was uploaded, linking its Transcript to a Ticket, uploading it again, or unlinking it.",
  "document.changed":
    "A Document in a page tree, the Workspace's (`projectId` null) or a Project's, was created, saved, moved or deleted.",
  "term.changed": "A Term in a glossary, the Workspace's (`projectId` null) or a Project's, was created, saved or deleted.",
  "decision.changed": "A Decision in a register, the Workspace's (`projectId` null) or a Project's, was recorded or saved.",
  "artifact.changed": "An Artifact of the Workspace (`projectId` null) or of a Project was created, saved or deleted.",
  "artifact.comments.changed": "A Comment was added to an Artifact, or a file attached to or removed from one of its Comments.",
  "transcript.changed":
    "A Transcript was uploaded again, with the session's newer entries, or deleted; `runId` names the Run it records, or null.",
  "attachments.changed":
    "A file was attached to or removed from a Ticket or one of its Comments (naming the Ticket), one of the Comments on an Artifact the Ticket links (naming the Ticket), or a Document (naming only the Document).",
};

/**
 * What a User's own Runners' event stream tells them: which of their Runners changed, by id. A Runner belongs to
 * a User, not a Workspace, so this goes to its Owner's stream and never to a Workspace's.
 */
export type RunnerEvent = { type: "runner.changed"; runnerId: string };

export const runnerEventTypes: Record<RunnerEvent["type"], string> = {
  "runner.changed":
    "A Run started or ended on one of your Runners, changing its count of running Runs, its queue was paused for a rate limit or resumed, or you removed it.",
};

/** An event that names its Project, or null for the Workspace's own knowledge, and so goes to those who can read it. */
export type PlacedEvent = Extract<LiveEvent, { projectId: string | null }>;

/**
 * Who an event goes to, among the Workspace's open streams: the Users who may read every place in `readersOf`
 * (Projects by id, null for the Workspace's own knowledge; every User for none), and the Users in `users` besides.
 * Leaving `readersOf` out sends to `users` alone.
 */
export interface Audience {
  readersOf?: (string | null)[];
  users?: string[];
}

/** One open stream: whose it is, and how to write to it. */
export interface Subscriber {
  /** The Workspace whose stream it is; null for its User's own Runners' stream. */
  workspaceId: string | null;
  userId: string;
  /** The hash of the sign-in the stream was opened with. */
  signIn: string;
  send(event: LiveEvent | RunnerEvent): void;
  end(): void;
}

/**
 * The open event streams of this server, and delivery to them once changes commit. Delivery
 * is in-process: changes made by another process, such as a server command, reach no stream.
 */
export class Live {
  private readonly subscribers = new Set<Subscriber>();
  private readonly listeners = new Set<(workspaceId: string, event: LiveEvent) => void>();
  private isClosed = false;

  /** Whether the server is closing, so no stream may stay open. */
  get closed(): boolean {
    return this.isClosed;
  }

  /**
   * Adds a stream. Once closed, the stream is ended as soon as the caller's code has run, rather than kept: a request
   * that was still checking its sign-in as the server began closing would otherwise hold the server open.
   */
  subscribe(subscriber: Subscriber): () => void {
    if (this.isClosed) {
      queueMicrotask(() => subscriber.end());
      return () => {};
    }
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  /**
   * Adds an in-process listener, told about every event published to a Workspace once it commits, whoever it goes to,
   * such as the notifier that sends Inbox items to webhooks. A listener that throws doesn't stop the others.
   */
  listen(listener: (workspaceId: string, event: LiveEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Ends every stream, and every stream subscribed from now on, as the server closes. */
  close(): void {
    this.isClosed = true;
    this.end(() => true);
  }

  /**
   * Tells the Workspace's streams about the event once the transaction commits, and never if it rolls back: only
   * those of Users who may read where it happened, as the transaction leaves Access. An event that names its Project
   * goes to that Project's readers; any other says who it goes to. The same event published again in the same
   * transaction is sent once: it tells nothing more, so a write that publishes and a caller that publishes after it
   * never send it twice.
   */
  publish(tx: Tx, workspaceId: string, event: PlacedEvent): void;
  publish(tx: Tx, workspaceId: string, event: LiveEvent, audience: Audience): void;
  publish(tx: Tx, workspaceId: string, event: LiveEvent, audience?: Audience): void {
    if (!firstInTransaction(tx, JSON.stringify([workspaceId, event, audience ?? null]))) return;
    const to = audience ?? { readersOf: [(event as PlacedEvent).projectId] };
    let recipients: Set<string> | "all" = new Set(to.users);
    // The Workspace's own knowledge is for every User of it, so that needs no lookup.
    if (to.readersOf?.every((place) => place === null)) recipients = "all";
    else if (to.readersOf) {
      const places = to.readersOf;
      beforeCommit(tx, async () => {
        const readers = await readersIn(tx, workspaceId, places);
        for (const user of to.users ?? []) readers.add(user);
        recipients = readers;
      });
    }
    this.sendAfterCommit(
      tx,
      (subscriber) =>
        subscriber.workspaceId === workspaceId && (recipients === "all" || recipients.has(subscriber.userId)),
      event,
    );
    afterCommit(tx, () => {
      for (const listener of this.listeners) {
        try {
          listener(workspaceId, event);
        } catch {
          // A listener's failure is its own; the change has committed.
        }
      }
    });
  }

  /** Tells the Runner's Owner's Runners streams about the event once the transaction commits. */
  publishToOwner(tx: Tx, ownerId: string, event: RunnerEvent): void {
    this.sendAfterCommit(tx, (subscriber) => subscriber.workspaceId === null && subscriber.userId === ownerId, event);
  }

  private sendAfterCommit(tx: Tx, to: (subscriber: Subscriber) => boolean, event: LiveEvent | RunnerEvent): void {
    afterCommit(tx, () => {
      for (const subscriber of this.subscribers) {
        if (!to(subscriber)) continue;
        // The change has committed whatever happens to one stream, so a failing stream only ends.
        try {
          subscriber.send(event);
        } catch {
          this.end((other) => other === subscriber);
        }
      }
    });
  }

  /** Ends the streams that match, such as those of a member who was removed. */
  end(matches: (subscriber: Subscriber) => boolean): void {
    for (const subscriber of [...this.subscribers]) {
      if (matches(subscriber)) {
        this.subscribers.delete(subscriber);
        subscriber.end();
      }
    }
  }

  /** Ends the streams once a transaction commits. */
  endAfterCommit(tx: Tx, matches: (subscriber: Subscriber) => boolean): void {
    afterCommit(tx, () => this.end(matches));
  }
}
