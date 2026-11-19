import { useCallback, useEffect, useRef } from "react";

/**
 * Live updates: one server-sent event stream per Workspace, shared by every screen that
 * listens to it. Events only name what changed; screens fetch it again through the API.
 */

export type LiveEvent =
  | { type: "project.created"; projectId: string }
  | { type: "project.changed" | "statuses.changed"; projectId: string }
  | { type: "ticket.created" | "ticket.changed"; projectId: string; ticketId: string }
  | { type: "comment.added"; projectId: string; ticketId: string; commentId: string }
  | { type: "report.added"; projectId: string; ticketId: string; reportId: string }
  /** A file was attached to or removed from a Ticket or one of its Comments, or a Document. */
  | { type: "attachments.changed"; projectId: string; ticketId: string }
  | { type: "attachments.changed"; documentId: string }
  /** The stream reconnected after a break, so events may have been missed: fetch everything again. */
  | { type: "reconnected" };

const eventTypes = ["project.created", "project.changed", "statuses.changed", "ticket.created", "ticket.changed", "comment.added", "report.added", "attachments.changed"];

type Listener = (event: LiveEvent) => void;

const streams = new Map<string, { source: EventSource; listeners: Set<Listener> }>();

function listen(workspaceId: string, listener: Listener): () => void {
  let stream = streams.get(workspaceId);
  if (!stream) {
    const source = new EventSource(`/api/workspaces/${encodeURIComponent(workspaceId)}/events`);
    const listeners = new Set<Listener>();
    const emit = (event: LiveEvent) => listeners.forEach((l) => l(event));
    let opened = false;
    source.addEventListener("open", () => {
      if (opened) emit({ type: "reconnected" });
      opened = true;
    });
    for (const type of eventTypes) {
      source.addEventListener(type, (message) => emit({ type, ...JSON.parse(message.data) } as LiveEvent));
    }
    stream = { source, listeners };
    streams.set(workspaceId, stream);
  }
  const { source, listeners } = stream;
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      source.close();
      streams.delete(workspaceId);
    }
  };
}

/** Calls `onEvent` with each event of the Workspace's stream while the component is shown. */
export function useLiveEvents(workspaceId: string, onEvent: Listener): void {
  const current = useRef(onEvent);
  current.current = onEvent;
  useEffect(() => listen(workspaceId, (event) => current.current(event)), [workspaceId]);
}

/**
 * Wraps fetches of one thing so that only the latest started is applied, even when an
 * earlier one answers later, as when several events arrive close together.
 */
export function useLatest(): <T>(fetch: Promise<T>, apply: (value: T) => void, fail?: (error: Error) => void) => void {
  const latest = useRef(0);
  useEffect(
    () => () => {
      latest.current++;
    },
    [],
  );
  return useCallback((fetch, apply, fail) => {
    const call = ++latest.current;
    fetch.then(
      (value) => call === latest.current && apply(value),
      (error: Error) => call === latest.current && fail?.(error),
    );
  }, []);
}
