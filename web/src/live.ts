import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api.js";

/**
 * Live updates: one server-sent event stream per Workspace, and one for the User's own Runners, each shared by
 * every screen that listens to it. Events only name what changed; screens fetch it again through the API.
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
  /** A Pull Request linked to a Ticket, or one linked to it changed its title, branch, state, checks or reviews. */
  | { type: "pull_requests.changed"; projectId: string; ticketId: string }
  /** A session outside a Run was uploaded, linking its Transcript to a Ticket, uploading it again, or unlinking it. */
  | { type: "transcripts.changed"; projectId: string; ticketId: string }
  /** A Document in a page tree, the Workspace's (`projectId` null) or a Project's, was created, saved, moved or deleted. */
  | { type: "document.changed"; projectId: string | null; documentId: string }
  /** A Term in a glossary was created, saved or deleted. */
  | { type: "term.changed"; projectId: string | null; termId: string }
  /** A Decision in a register was recorded or saved. */
  | { type: "decision.changed"; projectId: string | null; decisionId: string }
  /** An Artifact of the Workspace (`projectId` null) or of a Project was created or saved. */
  | { type: "artifact.changed"; projectId: string | null; artifactId: string }
  /** A Transcript was uploaded again, with its session's newer entries, or deleted. */
  | { type: "transcript.changed"; transcriptId: string; runId: string | null }
  /** The stream reconnected after a break, so events may have been missed: fetch everything again. */
  | { type: "reconnected" };

const eventTypes = ["project.created", "project.changed", "statuses.changed", "ticket.created", "ticket.changed", "comment.added", "report.added", "report.changed", "attachments.changed", "pull_requests.changed", "transcripts.changed", "document.changed", "term.changed", "decision.changed", "artifact.changed", "transcript.changed"];

/** What the User's own Runners' stream tells: a Run started or ended on one, or its queue paused or resumed. */
export type RunnerEvent = { type: "runner.changed"; runnerId: string } | { type: "reconnected" };

const runnerEventTypes = ["runner.changed"];

type Listener = (event: LiveEvent | RunnerEvent) => void;

/** Whether a stream is connected, or away and reconnecting. */
export type LiveState = "live" | "reconnecting";

interface Stream {
  source: EventSource;
  /** A reopening the browser gave up on, waiting to start. */
  retry?: ReturnType<typeof setTimeout>;
  listeners: Set<Listener>;
  state: LiveState;
  stateListeners: Set<(state: LiveState) => void>;
}

/** How long before reopening a stream the browser gave up on, doubling with each failure in a row up to the most. */
const reopenDelayMs = 3_000;
const maxReopenDelayMs = 30_000;

/** Open streams by their address. */
const streams = new Map<string, Stream>();

const workspaceStream = (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/events`;
const runnersStream = "/api/runners/events";

/** Opens the stream at `url`, or joins it if open, listening for its event `types`. */
function open(url: string, types: string[]): Stream {
  let stream = streams.get(url);
  if (!stream) {
    const created: Stream = { source: new EventSource(url), listeners: new Set(), state: "live", stateListeners: new Set() };
    const emit = (event: LiveEvent | RunnerEvent) => created.listeners.forEach((l) => l(event));
    const setState = (state: LiveState) => {
      created.state = state;
      created.stateListeners.forEach((l) => l(state));
    };
    let opened = false;
    let failures = 0;
    const watch = (source: EventSource) => {
      source.addEventListener("open", () => {
        failures = 0;
        setState("live");
        if (opened) emit({ type: "reconnected" });
        opened = true;
      });
      source.addEventListener("error", () => {
        setState("reconnecting");
        // The browser reconnects by itself after a dropped connection, but gives up on an answer with an
        // error status, such as a proxy's while Cronk restarts or a refusal while signed out: open it again.
        if (source.readyState !== EventSource.CLOSED) return;
        failures += 1;
        created.retry = setTimeout(() => {
          created.retry = undefined;
          if (streams.get(url) !== created) return;
          created.source = new EventSource(url);
          watch(created.source);
        }, Math.min(reopenDelayMs * 2 ** (failures - 1), maxReopenDelayMs));
      });
      for (const type of types) {
        source.addEventListener(type, (message) => emit({ type, ...JSON.parse(message.data) } as LiveEvent | RunnerEvent));
      }
    };
    watch(created.source);
    stream = created;
    streams.set(url, stream);
  }
  return stream;
}

/** Closes a stream once nothing listens to it any more. */
function release(url: string, stream: Stream) {
  if (stream.listeners.size === 0 && stream.stateListeners.size === 0) {
    stream.source.close();
    clearTimeout(stream.retry);
    streams.delete(url);
  }
}

function listen(url: string, types: string[], listener: Listener): () => void {
  const stream = open(url, types);
  stream.listeners.add(listener);
  return () => {
    stream.listeners.delete(listener);
    release(url, stream);
  };
}

function useStreamState(url: string, types: string[]): LiveState {
  const [state, setState] = useState<LiveState>(() => streams.get(url)?.state ?? "live");
  useEffect(() => {
    const stream = open(url, types);
    setState(stream.state);
    stream.stateListeners.add(setState);
    return () => {
      stream.stateListeners.delete(setState);
      release(url, stream);
    };
  }, [url, types]);
  return state;
}

/** Whether the Workspace's stream is live or reconnecting, for the Live indicator. */
export function useLiveState(workspaceId: string): LiveState {
  return useStreamState(workspaceStream(workspaceId), eventTypes);
}

/** Whether the User's own Runners' stream is live or reconnecting, for the Live indicator. */
export function useRunnersLiveState(): LiveState {
  return useStreamState(runnersStream, runnerEventTypes);
}

function useStreamEvents<E>(url: string | null, types: string[], onEvent: (event: E) => void): void {
  const current = useRef(onEvent);
  current.current = onEvent;
  useEffect(() => (url ? listen(url, types, (event) => current.current(event as E)) : undefined), [url, types]);
}

/** Calls `onEvent` with each event of the Workspace's stream while the component is shown. */
export function useLiveEvents(workspaceId: string, onEvent: (event: LiveEvent) => void): void {
  // Nothing streams without a Workspace, such as for a User who belongs to none.
  useStreamEvents(workspaceId ? workspaceStream(workspaceId) : null, eventTypes, onEvent);
}

/** Calls `onEvent` with each event of the User's own Runners' stream while the component is shown. */
export function useRunnerEvents(onEvent: (event: RunnerEvent) => void): void {
  useStreamEvents(runnersStream, runnerEventTypes, onEvent);
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

/**
 * Whether the item a page shows was deleted by someone else while shown, so the page keeps it on screen, marked,
 * until the User moves on. `failed` takes a live refetch's failure; `deleteHere` wraps the page's own delete, which
 * isn't someone else's.
 */
export function useDeletedElsewhere(): { gone: boolean; failed: (error: Error) => void; deleteHere: (remove: () => Promise<void>) => Promise<void> } {
  const [gone, setGone] = useState(false);
  const deletingHere = useRef(false);
  const failed = useCallback((error: Error) => {
    if (error instanceof ApiError && error.status === 404 && !deletingHere.current) setGone(true);
  }, []);
  const deleteHere = useCallback(async (remove: () => Promise<void>) => {
    deletingHere.current = true;
    try {
      await remove();
    } catch (error) {
      deletingHere.current = false;
      throw error;
    }
  }, []);
  return { gone, failed, deleteHere };
}
