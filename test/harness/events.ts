import type { StartedCronk } from "./start-cronk.js";

/** One server-sent event. */
export interface StreamEvent {
  event: string;
  data: unknown;
}

export interface EventStream {
  /** Resolves with the next event, or rejects if none arrives within the timeout. */
  next(timeoutMs?: number): Promise<StreamEvent>;
  /** Resolves once Cronk has ended the stream, or rejects if it is still open after the timeout. */
  ended(timeoutMs?: number): Promise<void>;
  close(): void;
}

/** Opens a Workspace's event stream as a signed-in client does, and reads it event by event. */
export async function openEvents(cronk: StartedCronk, workspaceId: string, cookie: string): Promise<EventStream> {
  const abort = new AbortController();
  const response = await fetch(new URL(`/api/workspaces/${workspaceId}/events`, cronk.url), {
    headers: { cookie, accept: "text/event-stream" },
    signal: abort.signal,
  });
  if (response.status !== 200) {
    abort.abort();
    throw Object.assign(new Error(`the stream answered ${response.status}`), { status: response.status });
  }
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const queue: StreamEvent[] = [];
  let buffer = "";
  let done = false;
  let wake: (() => void) | undefined;

  void (async () => {
    try {
      for (;;) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        buffer += value;
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const lines = block.split("\n").filter((line) => !line.startsWith(":"));
          if (lines.length === 0) continue;
          const field = (name: string) =>
            lines.filter((l) => l.startsWith(`${name}:`)).map((l) => l.slice(name.length + 1).trimStart());
          queue.push({ event: field("event")[0] ?? "message", data: JSON.parse(field("data").join("\n")) });
        }
        wake?.();
      }
    } catch {
      // Closed by the test.
    }
    done = true;
    wake?.();
  })();

  const waitFor = async <T>(ready: () => T | undefined, timeoutMs: number, what: string): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = ready();
      if (value !== undefined) return value;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out waiting for ${what}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  };

  return {
    next(timeoutMs = 2000) {
      return waitFor(
        () => {
          if (queue.length > 0) return queue.shift()!;
          if (done) throw new Error("the stream ended");
          return undefined;
        },
        timeoutMs,
        "an event",
      );
    },
    async ended(timeoutMs = 2000) {
      await waitFor(() => (done ? true : undefined), timeoutMs, "the stream to end");
    },
    close() {
      abort.abort();
    },
  };
}
