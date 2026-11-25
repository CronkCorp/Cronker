import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isRunning, readRunRecord, readRunRecords, type RunRecord } from "./history.js";
import { claudeCode } from "./program.js";
import { serviceFile, systemdUnitName } from "./service.js";

/**
 * `cronk-runner logs`: follows the Machine's Runs in the terminal, from the session JSONL Claude Code writes for each,
 * found through the Run records the daemon keeps (see `history.ts`). It only reads, so it works from a second terminal
 * while the daemon runs in the foreground or as a service.
 *
 * The text is shown as the JSONL holds it, not scrubbed for secrets as Transcripts in Cronk are: it stays on the User's
 * own Machine, read from a file in their own Claude Code config directory that holds the same text.
 */

export interface LogsOptions {
  /** The daemon's state directory, whose `history/` holds the Run records. */
  historyDir: string;
  /** The environment Claude Code's config directory is found by. */
  env: NodeJS.ProcessEnv;
  /** Prints a line of a Run's log. */
  print: (line: string) => void;
  /** Prints a line about the following itself, such as a Run starting or ending. */
  note: (line: string) => void;
  /** Prints the JSONL lines as Claude Code wrote them, instead of readable ones. */
  raw?: boolean;
  /** How often the files are read again: every half second when left out. */
  pollMs?: number;
  /** Stops following. */
  signal?: AbortSignal;
}

/** The fields a tool's input is best summed up by, in order, as the Transcript page sums it up. */
const summaryFields = ["description", "command", "file_path", "path", "pattern", "url", "query", "key", "prompt"];

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 200);

/** One line saying what a tool was called with. */
export function summarize(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input !== "object" || Array.isArray(input)) return oneLine(JSON.stringify(input));
  const fields = input as Record<string, unknown>;
  const named = summaryFields.map((field) => fields[field]).find((value) => typeof value === "string" && value.trim());
  if (typeof named === "string") return oneLine(named);
  const firstText = Object.values(fields).find((value) => typeof value === "string" && value.trim());
  if (typeof firstText === "string") return oneLine(firstText);
  const json = JSON.stringify(input);
  return json === "{}" ? "" : oneLine(json);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A tool result's text, from a string or a list of text blocks. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (isObject(block) && typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * The readable lines of one line of Claude Code's JSONL: the agent's text as it is, a tool call as `[Tool] summary`,
 * a failed tool result as `[error] …`, and a system notice as `[system] …`. The User's messages (the Brief), thinking,
 * successful tool results and lines of any other kind, or that aren't JSON, show nothing.
 */
export function renderLine(line: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isObject(parsed)) return [];
  if (parsed.type === "system")
    return typeof parsed.content === "string" && parsed.content.trim() ? [`[system] ${oneLine(parsed.content)}`] : [];
  if (parsed.type !== "user" && parsed.type !== "assistant") return [];
  const content = isObject(parsed.message) ? parsed.message.content : undefined;
  if (!Array.isArray(content)) return [];
  const lines: string[] = [];
  for (const block of content) {
    if (!isObject(block)) continue;
    if (parsed.type === "assistant" && block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      lines.push(...block.text.trim().split("\n"));
    } else if (parsed.type === "assistant" && block.type === "tool_use" && typeof block.name === "string") {
      const summary = summarize(block.input);
      lines.push(summary ? `[${block.name}] ${summary}` : `[${block.name}]`);
    } else if (block.type === "tool_result" && block.is_error === true) {
      lines.push(`[error] ${oneLine(resultText(block.content))}`.trimEnd());
    }
  }
  return lines;
}

/** The newest Run whose id is the target, or whose Ticket's key is, ignoring case. */
export function resolveRun(records: RunRecord[], target: string): RunRecord | undefined {
  const newestFirst = [...records].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return (
    newestFirst.find((record) => record.runId === target) ??
    newestFirst.find((record) => record.ticketKey.toLowerCase() === target.toLowerCase())
  );
}

/** Reads the lines appended to a file since the last read, keeping a last line not yet ended until it is. */
class Tail {
  private offset = 0;
  private partial = "";
  private decoder = new StringDecoder("utf8");

  /** The new complete lines, or null when the file is gone; `flush` also gives an unended last line. */
  async read(path: string, flush = false): Promise<string[] | null> {
    let handle;
    try {
      handle = await open(path, "r");
    } catch {
      return null;
    }
    try {
      const { size } = await handle.stat();
      if (size < this.offset) {
        // Replaced by a shorter file: start it over.
        this.offset = 0;
        this.partial = "";
        this.decoder = new StringDecoder("utf8");
      }
      if (size > this.offset) {
        const buffer = Buffer.alloc(size - this.offset);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.offset);
        this.offset += bytesRead;
        this.partial += this.decoder.write(buffer.subarray(0, bytesRead));
      }
    } finally {
      await handle.close();
    }
    const lines = this.partial.split("\n");
    this.partial = lines.pop() ?? "";
    if (flush && this.partial) {
      lines.push(this.partial);
      this.partial = "";
    }
    return lines.filter((line) => line.trim());
  }
}

/** Follows one Run's session: each step prints what was added, and says whether the Run has ended. */
function follower(options: LogsOptions, prefix: string) {
  const tail = new Tail();
  let path: string | null = null;
  let seen = false;
  const emit = (line: string) => {
    if (options.raw) options.print(line);
    else for (const shown of renderLine(line)) options.print(`${prefix}${shown}`);
  };
  return {
    /** Reads what the session added; true once the Run has ended and all of it was read. */
    async step(record: RunRecord): Promise<boolean> {
      const ended = !isRunning(record);
      path ??= record.transcriptPath ?? (record.sessionId ? await claudeCode().transcript(options.env, record.sessionId) : null);
      const lines = path ? await tail.read(path, ended) : null;
      if (lines) seen = true;
      for (const line of lines ?? []) emit(line);
      if (ended && !seen)
        options.note(
          `${record.ticketKey}: Run ${record.runId} ended, and its session file is gone or was never written.`,
        );
      return ended;
    },
  };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

const describe = (record: RunRecord) =>
  `${record.ticketKey} (Run ${record.runId}, started ${new Date(record.startedAt).toLocaleString()})`;

/**
 * `cronk-runner logs <ticket key or run id>`: prints the Run from its start and follows it until it ends; a Run that
 * ended already is printed whole. Returns the exit code.
 */
export async function followRun(target: string, options: LogsOptions): Promise<number> {
  const found = resolveRun(await readRunRecords(options.historyDir), target);
  if (!found) {
    options.note(
      `No Run of ${target} on this Machine: it may have run elsewhere, or ended over a week ago. \`cronk-runner logs\` follows the Runs running now.`,
    );
    return 1;
  }
  const wasRunning = isRunning(found);
  options.note(`${wasRunning ? "Following" : "Showing"} ${describe(found)}.`);
  const follow = follower(options, `${found.ticketKey}  `);
  let record = found;
  while (!(await follow.step(record))) {
    await sleep(options.pollMs ?? 500, options.signal);
    if (options.signal?.aborted) return 0;
    // A record pruned meanwhile is of a Run long ended.
    record = (await readRunRecord(options.historyDir, record.runId)) ?? { ...record, endedAt: record.startedAt };
  }
  if (wasRunning) options.note(`${record.ticketKey}: Run ${record.runId} ended.`);
  return 0;
}

/**
 * `cronk-runner logs`: follows every Run running on the Machine now, and each that starts later, each line led by its
 * Ticket's key, until stopped. Returns the exit code.
 */
export async function followRunning(options: LogsOptions): Promise<number> {
  const following = new Map<string, ReturnType<typeof follower>>();
  let first = true;
  while (!options.signal?.aborted) {
    const records = await readRunRecords(options.historyDir);
    const running = records.filter(isRunning).reverse();
    for (const record of running) {
      if (following.has(record.runId)) continue;
      following.set(record.runId, follower(options, `${record.ticketKey}  `));
      options.note(`Following ${describe(record)}.`);
    }
    if (first && running.length === 0)
      options.note("No Runs are running on this Machine now; waiting for one to start (Ctrl-C to stop).");
    first = false;
    for (const [runId, follow] of following) {
      const record = records.find((r) => r.runId === runId);
      if (!record || (await follow.step(record))) {
        following.delete(runId);
        options.note(`${record?.ticketKey ?? runId}: Run ${runId} ended.`);
      }
    }
    await sleep(options.pollMs ?? 500, options.signal);
  }
  return 0;
}

/** The command that shows the daemon's own log as a service, or why there is none to show. */
export function daemonLogCommand(
  platform: NodeJS.Platform,
  home: string,
  exists: (path: string) => boolean = existsSync,
): { command: string; args: string[] } | { problem: string } {
  const foreground = "A daemon started with `cronk-runner run` prints its log in its own terminal instead.";
  if (platform === "darwin") {
    const logPath = join(home, "Library", "Logs", "cronk-runner.log");
    if (!exists(logPath)) return { problem: `cronk-runner hasn't run as a service here: ${logPath} doesn't exist. ${foreground}` };
    return { command: "tail", args: ["-n", "200", "-F", logPath] };
  }
  if (platform === "linux") {
    const unit = serviceFile(platform, home)!;
    if (!exists(unit)) return { problem: `cronk-runner isn't installed as a service here (no ${unit}). ${foreground}` };
    return { command: "journalctl", args: ["--user", "-u", systemdUnitName, "-n", "200", "-f"] };
  }
  return { problem: `cronk-runner runs as a service only on macOS and Linux; this is ${platform}. ${foreground}` };
}

/** `cronk-runner logs --daemon`: follows the service's own log until stopped. Returns the exit code. */
export function followDaemonLog(home: string, note: (line: string) => void, platform = process.platform): Promise<number> {
  const how = daemonLogCommand(platform, home);
  if ("problem" in how) {
    note(how.problem);
    return Promise.resolve(1);
  }
  return new Promise((resolve) => {
    const child = spawn(how.command, how.args, { stdio: "inherit" });
    child.on("error", (error) => {
      note(`Couldn't run ${how.command}: ${error.message}`);
      resolve(1);
    });
    // Ctrl-C reaches it too: stopping it is how following ends.
    child.on("close", (code, signal) => resolve(signal === "SIGINT" || signal === "SIGTERM" ? 0 : (code ?? 0)));
  });
}
