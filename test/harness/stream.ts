import type { StartedCronk } from "./start-cronk.js";

/** One server-sent event as the stream delivered it, its data parsed as JSON. */
export interface LiveEvent {
  type: string;
  data: Record<string, unknown>;
}

export interface OpenStream {
  /** The next event, waiting up to `timeoutMs`; fails if none arrives. */
  next(timeoutMs?: number): Promise<LiveEvent>;
  /** Waits up to `ms` and fails if any event arrives meanwhile. */
  expectQuiet(ms?: number): Promise<void>;
  /** Resolves once the server ends the stream. */
  ended(timeoutMs?: number): Promise<void>;
  close(): void;
}

/**
 * Opens a Workspace's event stream the way any client would, over HTTP. Resolves once the
 * response has started, which is after the server has subscribed the stream, so changes the
 * test makes from then on are seen.
 */
export function openStream(cronk: StartedCronk, cookie: string, workspaceId: string): Promise<OpenStream> {
  return openEvents(cronk, { cookie }, `/api/workspaces/${workspaceId}/events`);
}

/** Opens the signed-in User's own Runners' event stream, as `openStream` opens a Workspace's. */
export function openRunnerStream(cronk: StartedCronk, cookie: string): Promise<OpenStream> {
  return openEvents(cronk, { cookie }, "/api/runners/events");
}

/** Opens a Machine's event stream with its Machine token, as its daemon does. */
export function openMachineStream(cronk: StartedCronk, machineToken: string): Promise<OpenStream> {
  return openEvents(cronk, { authorization: `Bearer ${machineToken}` }, "/api/machine/events");
}

async function openEvents(cronk: StartedCronk, headers: Record<string, string>, path: string): Promise<OpenStream> {
  const abort = new AbortController();
  const response = await fetch(new URL(path, cronk.url), {
    headers: { ...headers, accept: "text/event-stream" },
    signal: abort.signal,
  });
  if (response.status !== 200) throw new Error(`the stream answered ${response.status}: ${await response.text()}`);

  const events: LiveEvent[] = [];
  const waiters: (() => void)[] = [];
  let done = false;
  const wake = () => waiters.splice(0).forEach((w) => w());

  void (async () => {
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    try {
      for (;;) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        buffer += value;
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          let type = "message";
          const data: string[] = [];
          for (const line of block.split("\n")) {
            if (line.startsWith("event: ")) type = line.slice(7);
            else if (line.startsWith("data: ")) data.push(line.slice(6));
          }
          if (data.length) events.push({ type, data: JSON.parse(data.join("\n")) });
          wake();
        }
      }
    } catch {
      // Aborted by close().
    }
    done = true;
    wake();
  })();

  const waitFor = (condition: () => boolean, timeoutMs: number) =>
    new Promise<boolean>((resolve) => {
      const check = () => {
        if (condition()) {
          clearTimeout(timer);
          resolve(true);
        } else waiters.push(check);
      };
      const timer = setTimeout(() => resolve(false), timeoutMs);
      check();
    });

  return {
    async next(timeoutMs = 2000) {
      if (!(await waitFor(() => events.length > 0, timeoutMs))) throw new Error("no event arrived on the stream");
      return events.shift()!;
    },
    async expectQuiet(ms = 300) {
      if (await waitFor(() => events.length > 0, ms)) {
        throw new Error(`expected no event, got ${JSON.stringify(events[0])}`);
      }
    },
    async ended(timeoutMs = 2000) {
      if (!(await waitFor(() => done, timeoutMs))) throw new Error("the stream is still open");
    },
    close() {
      abort.abort();
    },
  };
}
