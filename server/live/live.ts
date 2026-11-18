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
  | { type: "report.added"; projectId: string; ticketId: string; reportId: string };

export const liveEventTypes: Record<LiveEvent["type"], string> = {
  "project.created": "A Project was created, with its Statuses.",
  "project.changed": "A Project's settings changed.",
  "statuses.changed": "A Project's Statuses were added, renamed, moved, given another kind or removed, or a Status's Step changed.",
  "ticket.created": "A Ticket was created.",
  "ticket.changed": "A Ticket's fields changed, its Status among them, or its Relations or Sub-Tickets, or one of its Runs started or ended.",
  "comment.added": "A Comment was added to a Ticket.",
  "report.added": "A Run wrote a Report on a Ticket.",
};

/** One open stream: whose it is, and how to write to it. */
export interface Subscriber {
  workspaceId: string;
  userId: string;
  /** The hash of the sign-in the stream was opened with. */
  signIn: string;
  send(event: LiveEvent): void;
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
    afterCommit(tx, () => {
      for (const subscriber of this.subscribers) {
        if (subscriber.workspaceId !== workspaceId) continue;
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
