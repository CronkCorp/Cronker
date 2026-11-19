import { afterCommit, type Tx } from "../db.js";

/**
 * What a Workspace's event stream tells its clients: which record changed, by id. Clients
 * fetch what they show again through the API, so an event carries no fields of its own.
 */
export type LiveEvent =
  | { type: "project.created"; projectId: string }
  | { type: "project.changed"; projectId: string }
  | { type: "statuses.changed"; projectId: string }
  | { type: "ticket.created"; projectId: string; ticketId: string }
  | { type: "ticket.changed"; projectId: string; ticketId: string }
  | { type: "comment.added"; projectId: string; ticketId: string; commentId: string }
  | { type: "report.added"; projectId: string; ticketId: string; reportId: string }
  | { type: "report.changed"; projectId: string; ticketId: string; reportId: string }
  | { type: "attachments.changed"; projectId: string; ticketId: string }
  | { type: "pull_requests.changed"; projectId: string; ticketId: string }
  | { type: "attachments.changed"; documentId: string };

export const liveEventTypes: Record<LiveEvent["type"], string> = {
  "project.created": "A Project was created, with its Statuses.",
  "project.changed": "A Project's settings changed.",
  "statuses.changed": "A Project's Statuses were added, renamed, moved, given another kind or removed, or a Status's Step changed.",
  "ticket.created": "A Ticket was created.",
  "ticket.changed": "A Ticket's fields changed, its Status among them, or its Relations or Sub-Tickets, or one of its Runs started or ended.",
  "comment.added": "A Comment was added to a Ticket.",
  "report.added": "A Run wrote a Report on a Ticket.",
  "report.changed": "A Report on a Ticket was saved as its next Version, or deleted.",
  "pull_requests.changed": "A Pull Request linked to a Ticket, or one linked to it changed: its title, branch, state, checks or reviews.",
  "attachments.changed":
    "A file was attached to or removed from a Ticket or one of its Comments (naming the Ticket), or a Document (naming only the Document).",
};

/**
 * What a User's own Runners' event stream tells them: which of their Runners changed, by id. A Runner belongs to
 * a User, not a Workspace, so this goes to its Owner's stream and never to a Workspace's.
 */
export type RunnerEvent = { type: "runner.changed"; runnerId: string };

export const runnerEventTypes: Record<RunnerEvent["type"], string> = {
  "runner.changed": "A Run started or ended on one of your Runners, changing its count of running Runs, or its queue was paused for a rate limit or resumed.",
};

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

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  /** Tells the Workspace's streams about the event once the transaction commits, and never if it rolls back. */
  publish(tx: Tx, workspaceId: string, event: LiveEvent): void {
    this.sendAfterCommit(tx, (subscriber) => subscriber.workspaceId === workspaceId, event);
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
