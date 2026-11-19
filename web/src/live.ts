import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Live updates: one server-sent event stream per Workspace, shared by every screen that
 * listens to it. Events only name what changed; screens fetch it again through the API.
 */

export type LiveEvent =
  | { type: "project.created"; projectId: string }
  | { type: "project.changed" | "statuses.changed"; projectId: string }
  | { type: "ticket.created" | "ticket.changed"; projectId: string; ticketId: string }
  | { type: "comment.added"; projectId: string; ticketId: string; commentId: string }
  | { type: "report.added" | "report.changed"; projectId: string; ticketId: string; reportId: string }
  /** A file was attached to or removed from a Ticket or one of its Comments, or a Document. */
  | { type: "attachments.changed"; projectId: string; ticketId: string }
  | { type: "attachments.changed"; documentId: string }
  /** The stream reconnected after a break, so events may have been missed: fetch everything again. */
  | { type: "reconnected" };

const eventTypes = ["project.created", "project.changed", "statuses.changed", "ticket.created", "ticket.changed", "comment.added", "report.added", "report.changed", "attachments.changed"];

type Listener = (event: LiveEvent) => void;

/** Whether a stream is connected, or away and reconnecting. */
export type LiveState = "live" | "reconnecting";

interface Stream {
  source: EventSource;
  listeners: Set<Listener>;
  state: LiveState;
  stateListeners: Set<(state: LiveState) => void>;
}

const streams = new Map<string, Stream>();

function open(workspaceId: string): Stream {
  let stream = streams.get(workspaceId);
  if (!stream) {
    const source = new EventSource(`/api/workspaces/${encodeURIComponent(workspaceId)}/events`);
    const created: Stream = { source, listeners: new Set(), state: "live", stateListeners: new Set() };
    const emit = (event: LiveEvent) => created.listeners.forEach((l) => l(event));
    const setState = (state: LiveState) => {
      created.state = state;
      created.stateListeners.forEach((l) => l(state));
    };
    let opened = false;
    source.addEventListener("open", () => {
      setState("live");
      if (opened) emit({ type: "reconnected" });
      opened = true;
    });
    source.addEventListener("error", () => setState("reconnecting"));
    for (const type of eventTypes) {
      source.addEventListener(type, (message) => emit({ type, ...JSON.parse(message.data) } as LiveEvent));
    }
    stream = created;
    streams.set(workspaceId, stream);
  }
  return stream;
}

/** Closes a stream once nothing listens to it any more. */
function release(workspaceId: string, stream: Stream) {
  if (stream.listeners.size === 0 && stream.stateListeners.size === 0) {
    stream.source.close();
    streams.delete(workspaceId);
  }
}

function listen(workspaceId: string, listener: Listener): () => void {
  const stream = open(workspaceId);
  stream.listeners.add(listener);
  return () => {
    stream.listeners.delete(listener);
    release(workspaceId, stream);
  };
}

/** Whether the Workspace's stream is live or reconnecting, for the Live indicator. */
export function useLiveState(workspaceId: string): LiveState {
  const [state, setState] = useState<LiveState>(() => streams.get(workspaceId)?.state ?? "live");
  useEffect(() => {
    const stream = open(workspaceId);
    setState(stream.state);
    stream.stateListeners.add(setState);
    return () => {
      stream.stateListeners.delete(setState);
      release(workspaceId, stream);
    };
  }, [workspaceId]);
  return state;
}

/** Calls `onEvent` with each event of the Workspace's stream while the component is shown. */
export function useLiveEvents(workspaceId: string, onEvent: Listener): void {
  const current = useRef(onEvent);
  current.current = onEvent;
  // Nothing streams without a Workspace, such as for a User who belongs to none.
  useEffect(() => (workspaceId ? listen(workspaceId, (event) => current.current(event)) : undefined), [workspaceId]);
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

/**
 * Which of the shown entries arrived since the view first loaded, for the short accent ring that marks a new entry.
 * Counting starts once the view is `ready`, so what its first load brings isn't marked. An entry stays marked for
 * about 2s.
 */
export function useArrivals(keys: string[], ready = true): Set<string> {
  const seen = useRef<Set<string> | null>(null);
  const [arrived, setArrived] = useState<Set<string>>(new Set());
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const joined = keys.join("\n");
  useEffect(() => {
    const now = joined ? joined.split("\n") : [];
    if (!ready) return;
    if (seen.current === null) {
      seen.current = new Set(now);
      return;
    }
    const fresh = now.filter((key) => !seen.current!.has(key));
    now.forEach((key) => seen.current!.add(key));
    if (fresh.length === 0) return;
    setArrived((shown) => new Set([...shown, ...fresh]));
    timers.current.push(
      setTimeout(() => setArrived((shown) => new Set([...shown].filter((key) => !fresh.includes(key)))), 2000),
    );
  }, [joined, ready]);
  return arrived;
}
