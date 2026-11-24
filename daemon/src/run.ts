import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { call, CronkError, type ClaimedRepository, type ClaimedRun, type HeartbeatAnswer, type RunEnded } from "./api.js";
import { readConfig, type PairedCronk } from "./config.js";
import { repositoryCache, type RunWorkspace } from "./repositories.js";

/**
 * `cronk-runner run`: the daemon's foreground service. For each paired Cronk it keeps the Machine's event stream open,
 * claims the Runs it announces while the Machine's limit has room, and runs each with `claude -p` in a fresh scratch
 * directory holding a fresh worktree of each of its Repositories: reporting its session id, heartbeating it while it
 * runs, and reporting how the process ended. The worktrees are removed once the Run ended, unless it is lost and may
 * yet come back: then they are kept until Cronk says otherwise.
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
  /**
   * Where the bare clones of the Repositories live: `cronk-runner/repositories` under `$XDG_CACHE_HOME`, else under
   * `~/.cache`, when left out.
   */
  cacheDir?: string;
  /** The remote a Repository is fetched from and pushed to; its clone URL when left out. Tests point it elsewhere. */
  remoteFor?: (repository: ClaimedRepository) => string;
  /** How often a lost Run's kept worktree is checked on; as often as heartbeats when left out. */
  lostCheckMs?: number;
}

/** Where the bare clones live unless the options say otherwise. */
export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "cronk-runner", "repositories");
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

/** One Run the daemon holds: its process, and how to stop it. */
interface HeldRun {
  kill(): void;
  ended: Promise<void>;
}

export function runDaemon(options: RunOptions): RunningDaemon {
  const { print, heartbeatMs = 60_000, reconnectMs = 1_000 } = options;
  const env = options.env ?? process.env;
  const claude = options.claude ?? "claude";
  const scratchRoot = options.scratchRoot ?? tmpdir();
  const lostCheckMs = options.lostCheckMs ?? heartbeatMs;
  const repositories = repositoryCache({ directory: options.cacheDir ?? defaultCacheDir(env), remoteFor: options.remoteFor });
  const held = new Map<string, HeldRun>();
  /** Lost Runs' kept worktrees, checked on until Cronk says the Run won't come back. */
  const kept = new Set<NodeJS.Timeout>();
  /** Runs announced but not claimed yet, waiting for room under the Machine's limit, by Cronk and Run. */
  const pending = new Map<string, { cronk: PairedCronk; runId: string }>();
  const aborts = new Set<AbortController>();
  let stopped = false;
  let limit = 2;
  let claiming = Promise.resolve();

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
          headers: { authorization: `Bearer ${cronk.token}`, accept: "text/event-stream" },
          signal: abort.signal,
        });
        if (response.status === 401) {
          print(`${cronk.url}: this Machine was unpaired: run \`cronk-runner login ${cronk.url}\` again.`);
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
          claimed = await call<ClaimedRun>(cronk.url, "POST", `/api/machine/runs/${runId}/claim`, { token: cronk.token });
        } catch (error) {
          // Full on Cronk's count (it counts Runs of every daemon of this Machine): it waits for room here.
          if (error instanceof CronkError && error.code === "machine_limit_reached") return;
          // Claimed by another Machine, ended meanwhile, or Cronk unreachable: the stream tells it again if it still waits.
          pending.delete(key);
          if (!(error instanceof CronkError && error.code === "run_not_claimable")) {
            print(`${cronk.url}: couldn't claim Run ${runId}: ${(error as Error).message}`);
          }
          continue;
        }
        pending.delete(key);
        await start(cronk, claimed).catch(async (error: unknown) => {
          const reason = `the Machine couldn't start the Run: ${(error as Error).message}`;
          await call(cronk.url, "POST", `/api/machine/runs/${runId}/end`, { token: cronk.token, body: { reason } }).catch(() => {});
          print(`${claimed.ticketKey}: ${reason}`);
        });
      }
    });
  }

  /** Runs a claimed Run's `claude` process in a fresh scratch directory with its worktrees, until it exits. */
  async function start(cronk: PairedCronk, claimed: ClaimedRun): Promise<void> {
    const { runId } = claimed;
    const report = <T = unknown>(path: string, body?: unknown) =>
      call<T>(cronk.url, "POST", `/api/machine/runs/${runId}/${path}`, { token: cronk.token, body });
    const directory = await mkdtemp(join(scratchRoot, "cronk-run-"));
    let workspace: RunWorkspace;
    try {
      workspace = await repositories.prepare(directory, claimed.repositories ?? [], env);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    const cleanUp = async () => {
      await workspace.remove();
      await rm(directory, { recursive: true, force: true });
    };
    // The Run's token goes in a file only its User reads, outside the directory the agent works in, never in argv.
    const mcpConfigPath = join(directory, "mcp.json");
    const mcpConfig = {
      mcpServers: {
        [mcpServerName]: { type: "http", url: claimed.mcpUrl, headers: { authorization: `Bearer ${claimed.token}` } },
      },
    };
    await writeFile(mcpConfigPath, JSON.stringify(mcpConfig), { mode: 0o600 });
    print(`${claimed.ticketKey}: running Run ${runId} with ${claimed.modelId}.`);

    const child = spawn(claude, claudeArguments(claimed, mcpConfigPath), {
      cwd: workspace.cwd,
      env: { ...env, ...workspace.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let lastError = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      const lines = chunk.trim().split("\n");
      lastError = lines.at(-1) ?? lastError;
    });
    let sessionReported = false;
    createInterface({ input: child.stdout }).on("line", (line) => {
      let message: { type?: unknown; subtype?: unknown; session_id?: unknown };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        return;
      }
      if (!sessionReported && message.type === "system" && message.subtype === "init" && typeof message.session_id === "string") {
        sessionReported = true;
        report("session", { sessionId: message.session_id }).catch(() => {});
      }
    });

    const heartbeat = setInterval(() => {
      report<HeartbeatAnswer>("heartbeat").then(
        (answer) => workspace.refresh(answer.repositories ?? []),
        (error: unknown) => {
          // Cronk no longer runs the Run, as when a User took its Ticket away: its process stops too.
          if (error instanceof CronkError && (error.code === "run_stopped" || error.status === 404)) {
            print(`${claimed.ticketKey}: Run ${runId} was stopped in Cronk; stopping claude.`);
            child.kill("SIGTERM");
          }
        },
      ).catch((error: unknown) => print(`${claimed.ticketKey}: couldn't write fresh GitHub tokens: ${(error as Error).message}`));
    }, heartbeatMs);

    let resolveEnded!: () => void;
    const ended = new Promise<void>((resolve) => (resolveEnded = resolve));
    held.set(runId, { kill: () => child.kill("SIGTERM"), ended });
    let done = false;
    const end = async (reason: string) => {
      if (done) return;
      done = true;
      clearInterval(heartbeat);
      // A Run its agent finished ended already in Cronk, which then leaves it as it is.
      const ended = await report<RunEnded>("end", { reason }).catch((error: unknown) => {
        print(`${claimed.ticketKey}: couldn't report its end: ${(error as Error).message}`);
        return undefined;
      });
      if (ended?.mayComeBack) {
        print(`${claimed.ticketKey}: Run ${runId} is lost in Cronk; keeping its worktree until it is stopped or ended.`);
        keepWhileLost(report, cleanUp);
      } else {
        await cleanUp();
      }
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

  /** Asks Cronk about a lost Run until it says the Run won't come back, then cleans up. */
  function keepWhileLost(report: <T>(path: string, body?: unknown) => Promise<T>, cleanUp: () => Promise<void>): void {
    const check = setInterval(() => {
      report<RunEnded>("end", { reason: "claude had exited" }).then(
        async (ended) => {
          if (ended.mayComeBack || !kept.has(check)) return;
          kept.delete(check);
          clearInterval(check);
          await cleanUp();
        },
        async (error: unknown) => {
          // Unpaired, or the Run is gone: nothing will come back for it.
          if (error instanceof CronkError && (error.status === 401 || error.status === 404) && kept.delete(check)) {
            clearInterval(check);
            await cleanUp();
          }
        },
      );
    }, lostCheckMs);
    kept.add(check);
  }

  return {
    held: () => [...held.keys()],
    async stop() {
      stopped = true;
      // Kept worktrees stay on disk, as the Runs may yet come back.
      for (const check of kept) clearInterval(check);
      kept.clear();
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
