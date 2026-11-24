import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { call, CronkError, machineHeaders, upload, type ClaimedRun } from "./api.js";
import { readConfig, type PairedCronk } from "./config.js";

/**
 * `cronk-runner run`: the daemon's foreground service. For each paired Cronk it keeps the Machine's event stream open,
 * claims the Runs it announces while the Machine's limit has room, and runs each with `claude -p` in a fresh scratch
 * directory: reporting its session id, heartbeating it while it runs, uploading its transcript as it goes, and
 * reporting how the process ended, with the cost Claude Code estimated.
 */

export interface RunOptions {
  configPath: string;
  print: (line: string) => void;
  /** The Claude Code executable, looked up on the `PATH` of `env`; `claude` when left out. */
  claude?: string;
  /** The environment `claude` runs with; the daemon's own when left out. */
  env?: NodeJS.ProcessEnv;
  /** How often a running Run is heartbeated: every minute, well inside the lost-Run threshold, when left out. */
  heartbeatMs?: number;
  /** How long to wait before connecting again after a stream ends; grows up to a minute. */
  reconnectMs?: number;
  /** Where each Run's scratch directory is made; the OS's temporary directory when left out. */
  scratchRoot?: string;
  /** How often a running Run's transcript is uploaded, when it changed: every 10 seconds when left out. */
  transcriptMs?: number;
}

export interface RunningDaemon {
  /** The Runs it holds now, by id. */
  held(): string[];
  /** Ends the streams and kills the Runs' processes, waiting until each has reported its end. */
  stop(): Promise<void>;
}

/** The name Cronk's MCP server goes by in a Run's `--mcp-config`, so `mcp__cronk` allows its tools. */
const mcpServerName = "cronk";

/** The arguments `claude` runs a claimed Run with. */
export function claudeArguments(claimed: ClaimedRun, mcpConfigPath: string): string[] {
  return [
    "-p",
    claimed.brief,
    "--model",
    claimed.modelId,
    "--output-format",
    "stream-json",
    // `-p` refuses `stream-json` output without it.
    "--verbose",
    "--mcp-config",
    mcpConfigPath,
    // In `-p` mode a tool not allowed is denied, so Cronk's own must be, for the agent to call `finish`.
    "--allowedTools",
    `mcp__${mcpServerName}`,
  ];
}

/**
 * Where Claude Code writes a session's transcript: `<config dir>/projects/<encoded cwd>/<session id>.jsonl`, the config
 * directory being `$CLAUDE_CONFIG_DIR` or `~/.claude`. The encoded cwd is looked up rather than computed, as a
 * symlinked temporary directory (macOS's `/var`) makes it differ from the path the daemon knows.
 */
export async function findTranscript(env: NodeJS.ProcessEnv, sessionId: string): Promise<string | null> {
  const projects = join(env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude"), "projects");
  const directories = await readdir(projects).catch(() => [] as string[]);
  for (const directory of directories) {
    const path = join(projects, directory, `${sessionId}.jsonl`);
    if (await stat(path).then((s) => s.isFile(), () => false)) return path;
  }
  return null;
}

/** One Run the daemon holds: its process, and how to stop it. */
interface HeldRun {
  kill(): void;
  ended: Promise<void>;
}

export function runDaemon(options: RunOptions): RunningDaemon {
  const { print, heartbeatMs = 60_000, reconnectMs = 1_000, transcriptMs = 10_000 } = options;
  const env = options.env ?? process.env;
  const claude = options.claude ?? "claude";
  const scratchRoot = options.scratchRoot ?? tmpdir();
  const held = new Map<string, HeldRun>();
  /** Runs announced but not claimed yet, waiting for room under the Machine's limit, by Cronk and Run. */
  const pending = new Map<string, { cronk: PairedCronk; runId: string }>();
  const aborts = new Set<AbortController>();
  let stopped = false;
  let limit = 2;
  let claiming = Promise.resolve();

  /** A call's headers for the Cronk: the Machine token, the daemon's version and the Machine's limit. */
  const headers = (cronk: PairedCronk) => machineHeaders(cronk.token, limit);

  const configRead = readConfig(options.configPath).then((config) => {
    limit = config.limit;
    if (config.cronks.length === 0) print("This Machine isn't paired with any Cronk yet: run `cronk-runner login <url>`.");
    return config;
  });
  const connections = configRead.then((config) => Promise.all(config.cronks.map((cronk) => connect(cronk))));
  connections.catch((error: unknown) => print(`Couldn't start: ${(error as Error).message}`));

  /** Keeps the Cronk's event stream open until the daemon stops or the Machine is unpaired, reconnecting with backoff. */
  async function connect(cronk: PairedCronk): Promise<void> {
    let wait = reconnectMs;
    while (!stopped) {
      const abort = new AbortController();
      aborts.add(abort);
      try {
        const response = await fetch(`${cronk.url}/api/machine/events`, {
          headers: { ...machineHeaders(cronk.token, limit), accept: "text/event-stream" },
          signal: abort.signal,
        });
        if (response.status === 401) {
          print(`${cronk.url}: this Machine was unpaired: run \`cronk-runner login ${cronk.url}\` again.`);
          return;
        }
        if (response.status === 426) {
          // Connecting again won't help until the daemon is upgraded.
          const refusal = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
          print(`${cronk.url}: refused: ${refusal.error?.message ?? "this cronk-runner is too old for it; upgrade it."}`);
          return;
        }
        if (!response.ok || !response.body) throw new Error(`Cronk answered ${response.status}.`);
        print(`${cronk.url}: connected.`);
        wait = reconnectMs;
        for await (const event of serverSentEvents(response.body)) {
          if (event.type !== "run.claimable") continue;
          const { runId } = JSON.parse(event.data) as { runId: string };
          pending.set(`${cronk.url} ${runId}`, { cronk, runId });
          claimWaiting();
        }
      } catch (error) {
        if (stopped) return;
        print(`${cronk.url}: lost the connection (${(error as Error).message}); connecting again.`);
      } finally {
        aborts.delete(abort);
      }
      if (stopped) return;
      await new Promise((resolve) => setTimeout(resolve, wait));
      wait = Math.min(wait * 2, 60_000);
    }
  }

  /** Claims waiting Runs, one at a time, while the Machine's limit has room. */
  function claimWaiting(): void {
    claiming = claiming.then(async () => {
      for (const [key, { cronk, runId }] of pending) {
        if (stopped || held.size >= limit) return;
        let claimed: ClaimedRun;
        try {
          claimed = await call<ClaimedRun>(cronk.url, "POST", `/api/machine/runs/${runId}/claim`, { headers: headers(cronk) });
        } catch (error) {
          // Full on Cronk's count (it counts Runs of every daemon of this Machine): it waits for room here.
          if (error instanceof CronkError && error.code === "machine_limit_reached") return;
          // Its Runner is full, as when its limit was lowered: it waits here, while other Runners' Runs may go.
          if (error instanceof CronkError && error.code === "runner_limit_reached") continue;
          // Claimed by another Machine, ended meanwhile, or Cronk unreachable: the stream tells it again if it still waits.
          pending.delete(key);
          if (!(error instanceof CronkError && error.code === "run_not_claimable")) {
            print(`${cronk.url}: couldn't claim Run ${runId}: ${(error as Error).message}`);
          }
          continue;
        }
        pending.delete(key);
        await start(cronk, claimed).catch(async (error: unknown) => {
          const reason = `the Machine couldn't start claude: ${(error as Error).message}`;
          await call(cronk.url, "POST", `/api/machine/runs/${runId}/end`, { headers: headers(cronk), body: { reason } }).catch(() => {});
          print(`${claimed.ticketKey}: ${reason}`);
        });
      }
    });
  }

  /** Runs a claimed Run's `claude` process in a fresh scratch directory, until it exits. */
  async function start(cronk: PairedCronk, claimed: ClaimedRun): Promise<void> {
    const { runId } = claimed;
    const report = (path: string, body?: unknown) =>
      call(cronk.url, "POST", `/api/machine/runs/${runId}/${path}`, { headers: headers(cronk), body });
    const directory = await mkdtemp(join(scratchRoot, "cronk-run-"));
    const work = join(directory, "work");
    await mkdir(work);
    // The Run's token goes in a file only its User reads, outside the directory the agent works in, never in argv.
    const mcpConfigPath = join(directory, "mcp.json");
    const mcpConfig = {
      mcpServers: {
        [mcpServerName]: { type: "http", url: claimed.mcpUrl, headers: { authorization: `Bearer ${claimed.token}` } },
      },
    };
    await writeFile(mcpConfigPath, JSON.stringify(mcpConfig), { mode: 0o600 });
    print(`${claimed.ticketKey}: running Run ${runId} with ${claimed.modelId}.`);

    const child = spawn(claude, claudeArguments(claimed, mcpConfigPath), { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] });
    let lastError = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      const lines = chunk.trim().split("\n");
      lastError = lines.at(-1) ?? lastError;
    });
    let sessionId: string | null = null;
    let sessionReported: Promise<unknown> = Promise.resolve();
    /** What Claude Code's `result` message said the session cost, in US dollars; none if it ended without one. */
    let costUsd: number | undefined;
    createInterface({ input: child.stdout }).on("line", (line) => {
      let message: { type?: unknown; subtype?: unknown; session_id?: unknown; total_cost_usd?: unknown };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        return;
      }
      if (!sessionId && message.type === "system" && message.subtype === "init" && typeof message.session_id === "string") {
        sessionId = message.session_id;
        sessionReported = report("session", { sessionId }).catch(() => {});
      }
      if (message.type === "result" && typeof message.total_cost_usd === "number" && Number.isFinite(message.total_cost_usd)) {
        costUsd = Math.max(0, message.total_cost_usd);
      }
    });

    // The transcript follows the session: uploaded whole whenever its file changed, one upload at a time.
    let transcriptPath: string | null = null;
    let uploaded = "";
    let uploads = true;
    let uploading: Promise<void> = Promise.resolve();
    const uploadTranscript = () =>
      (uploading = uploading.then(async () => {
        if (!uploads || !sessionId) return;
        transcriptPath ??= await findTranscript(env, sessionId);
        if (!transcriptPath) return;
        const file = await stat(transcriptPath).catch(() => null);
        const version = file ? `${file.size} ${file.mtimeMs}` : "";
        if (!file || version === uploaded) return;
        const body = await readFile(transcriptPath, "utf8");
        await sessionReported;
        try {
          await upload(cronk.url, "PUT", `/api/machine/runs/${runId}/transcript`, {
            body,
            contentType: "application/x-ndjson",
            headers: headers(cronk),
          });
          uploaded = version;
        } catch (error) {
          // A User deleted its Transcript, or the Machine no longer holds the Run: later uploads would be refused too.
          if (error instanceof CronkError && (error.code === "transcript_deleted" || error.status === 404 || error.status === 401)) {
            uploads = false;
          } else {
            print(`${claimed.ticketKey}: couldn't upload its transcript: ${(error as Error).message}`);
          }
        }
      }).catch((error: unknown) => print(`${claimed.ticketKey}: couldn't read its transcript: ${(error as Error).message}`)));
    const transcriptTimer = setInterval(() => void uploadTranscript(), transcriptMs);

    const heartbeat = setInterval(() => {
      report("heartbeat").catch((error: unknown) => {
        // Cronk no longer runs the Run, as when a User took its Ticket away: its process stops too.
        if (error instanceof CronkError && (error.code === "run_stopped" || error.status === 404)) {
          print(`${claimed.ticketKey}: Run ${runId} was stopped in Cronk; stopping claude.`);
          child.kill("SIGTERM");
        }
      });
    }, heartbeatMs);

    let resolveEnded!: () => void;
    const ended = new Promise<void>((resolve) => (resolveEnded = resolve));
    held.set(runId, { kill: () => child.kill("SIGTERM"), ended });
    let done = false;
    const end = async (reason: string) => {
      if (done) return;
      done = true;
      clearInterval(heartbeat);
      clearInterval(transcriptTimer);
      // Once more after the process ended, so the Transcript in Cronk is complete.
      await uploadTranscript();
      // A Run its agent finished ended already in Cronk, which then leaves it as it is; the cost is recorded either way.
      await report("end", { reason, ...(costUsd === undefined ? {} : { costUsd }) }).catch((error: unknown) => print(`${claimed.ticketKey}: couldn't report its end: ${(error as Error).message}`));
      await rm(directory, { recursive: true, force: true });
      held.delete(runId);
      print(`${claimed.ticketKey}: Run ${runId} ended: ${reason}.`);
      resolveEnded();
      claimWaiting();
    };
    child.on("error", (error) => void end(`couldn't run ${claude}: ${error.message}`));
    child.on("close", (code, signal) => {
      const how = signal ? `claude was killed by ${signal}` : `claude exited with code ${code}`;
      void end(code !== 0 && lastError ? `${how}: ${lastError}` : how);
    });
  }

  return {
    held: () => [...held.keys()],
    async stop() {
      stopped = true;
      for (const abort of aborts) abort.abort();
      await connections.catch(() => {});
      await claiming;
      const ending = [...held.values()];
      for (const run of ending) run.kill();
      await Promise.all(ending.map((run) => run.ended));
    },
  };
}

/** The events of a `text/event-stream` body, each with its type and data, skipping comments. */
async function* serverSentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ type: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
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
      if (data.length) yield { type, data: data.join("\n") };
    }
  }
}
