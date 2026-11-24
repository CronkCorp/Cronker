import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { call, CronkError, type ClaimedRun } from "./api.js";
import { readConfig, type PairedCronk } from "./config.js";

/**
 * `cronk-runner run`: the daemon's foreground service. For each paired Cronk it keeps the Machine's event stream open,
 * claims the Runs it announces while the Machine's limit has room, and runs each with `claude -p` in a fresh scratch
 * directory: reporting its session id, heartbeating it while it runs, and reporting how the process ended. A Run
 * stopped in Cronk is killed and its stop confirmed. Each running process is recorded in the state directory, so a
 * daemon starting again kills those it left behind and reports their Runs ended.
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
  /** Where the running processes are recorded; `runs/` next to the config when left out. */
  stateDir?: string;
  /** How long a killed `claude` has to exit after SIGTERM before it gets SIGKILL: ten seconds when left out. */
  killGraceMs?: number;
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
  cronkUrl: string;
  kill(): void;
  ended: Promise<void>;
}

/** What the state directory records of a running process, in `<runId>.json`. */
interface ProcessRecord {
  runId: string;
  cronkUrl: string;
  pid: number;
  /** The Run's scratch directory. */
  directory: string;
  /** The `--mcp-config` path, unique to the Run, which the process's command line must carry to be killed. */
  mcpConfigPath: string;
}

/** The state directory, next to the config at the path. */
export const stateDirOf = (configPath: string): string => join(dirname(configPath), "runs");

export function runDaemon(options: RunOptions): RunningDaemon {
  const { print, heartbeatMs = 60_000, reconnectMs = 1_000 } = options;
  const env = options.env ?? process.env;
  const claude = options.claude ?? "claude";
  const scratchRoot = options.scratchRoot ?? tmpdir();
  const stateDir = options.stateDir ?? stateDirOf(options.configPath);
  const killGraceMs = options.killGraceMs ?? 10_000;
  const held = new Map<string, HeldRun>();
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
  const connections = configRead.then(async (config) => {
    await killLeftovers(config.cronks);
    await Promise.all(config.cronks.map((cronk) => connect(cronk)));
  });
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
          // Cronk stopped the Runs it held; nothing keeps running for a Cronk it can no longer reach.
          const ending = [...held.values()].filter((run) => run.cronkUrl === cronk.url);
          for (const run of ending) run.kill();
          await Promise.all(ending.map((run) => run.ended));
          return;
        }
        if (!response.ok || !response.body) throw new Error(`Cronk answered ${response.status}.`);
        print(`${cronk.url}: connected.`);
        wait = reconnectMs;
        for await (const event of serverSentEvents(response.body)) {
          if (event.type === "run.claimable") {
            const { runId } = JSON.parse(event.data) as { runId: string };
            pending.set(`${cronk.url} ${runId}`, { cronk, runId });
            claimWaiting();
          } else if (event.type === "run.stop") {
            const { runId } = JSON.parse(event.data) as { runId: string };
            void stopRun(cronk, runId);
          }
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
          const reason = `the Machine couldn't start claude: ${(error as Error).message}`;
          await call(cronk.url, "POST", `/api/machine/runs/${runId}/end`, { token: cronk.token, body: { reason } }).catch(() => {});
          print(`${claimed.ticketKey}: ${reason}`);
        });
      }
    });
  }

  /** Kills a Run Cronk stopped, if it still runs here, waits for it to end and be cleaned up, and confirms the stop. */
  async function stopRun(cronk: PairedCronk, runId: string): Promise<void> {
    pending.delete(`${cronk.url} ${runId}`);
    const run = held.get(runId);
    if (run) {
      print(`Run ${runId} was stopped in Cronk; stopping claude.`);
      run.kill();
      await run.ended;
    }
    await call(cronk.url, "POST", `/api/machine/runs/${runId}/stopped`, { token: cronk.token }).catch(() => {});
  }

  /** Kills the `claude` processes a daemon before this one left running, and reports their Runs ended. */
  async function killLeftovers(cronks: PairedCronk[]): Promise<void> {
    let names: string[];
    try {
      names = (await readdir(stateDir)).filter((name) => name.endsWith(".json"));
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(stateDir, name);
      let record: ProcessRecord;
      try {
        record = JSON.parse(await readFile(path, "utf8")) as ProcessRecord;
      } catch {
        await rm(path, { force: true });
        continue;
      }
      // A pid is reused once its process is gone: only a process still running this Run's command is killed.
      if ((await commandLineOf(record.pid))?.includes(record.mcpConfigPath)) await killProcess(record.pid, killGraceMs);
      await rm(record.directory, { recursive: true, force: true });
      const cronk = cronks.find((c) => c.url === record.cronkUrl);
      if (cronk) {
        // A Run that ended meanwhile, or isn't this Machine's any more, is left as it is.
        await call(cronk.url, "POST", `/api/machine/runs/${record.runId}/end`, { token: cronk.token, body: { reason: "runner restarted" } }).catch(
          () => {},
        );
      }
      await rm(path, { force: true });
      print(`Run ${record.runId}: killed what the last daemon left running; its Run ended (runner restarted).`);
    }
  }

  /** Runs a claimed Run's `claude` process in a fresh scratch directory, until it exits. */
  async function start(cronk: PairedCronk, claimed: ClaimedRun): Promise<void> {
    const { runId } = claimed;
    const report = (path: string, body?: unknown) =>
      call(cronk.url, "POST", `/api/machine/runs/${runId}/${path}`, { token: cronk.token, body });
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
    const recordPath = join(stateDir, `${runId}.json`);
    const recorded =
      child.pid === undefined
        ? Promise.resolve()
        : mkdir(stateDir, { recursive: true, mode: 0o700 })
            .then(() => {
              const record: ProcessRecord = { runId, cronkUrl: cronk.url, pid: child.pid!, directory, mcpConfigPath };
              return writeFile(recordPath, JSON.stringify(record), { mode: 0o600 });
            })
            .catch((error: unknown) => print(`${claimed.ticketKey}: couldn't record its process: ${(error as Error).message}`));
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
      report("heartbeat").catch((error: unknown) => {
        // Cronk no longer runs the Run, as when a User took its Ticket away: its process stops too.
        if (error instanceof CronkError && (error.code === "run_stopped" || error.status === 404)) void stopRun(cronk, runId);
      });
    }, heartbeatMs);

    let resolveEnded!: () => void;
    const ended = new Promise<void>((resolve) => (resolveEnded = resolve));
    let killed = false;
    const kill = () => {
      if (killed || child.exitCode !== null || child.signalCode !== null) return;
      killed = true;
      child.kill("SIGTERM");
      // A process that ignores SIGTERM, or hangs on it, doesn't outlive the grace.
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, killGraceMs).unref();
    };
    held.set(runId, { cronkUrl: cronk.url, kill, ended });
    let done = false;
    const end = async (reason: string) => {
      if (done) return;
      done = true;
      clearInterval(heartbeat);
      // A Run its agent finished ended already in Cronk, which then leaves it as it is.
      await report("end", { reason }).catch((error: unknown) => print(`${claimed.ticketKey}: couldn't report its end: ${(error as Error).message}`));
      await rm(directory, { recursive: true, force: true });
      await recorded;
      await rm(recordPath, { force: true });
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

/** The command line of the process with the pid, or undefined once it is gone. */
async function commandLineOf(pid: number): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    // Linux: the arguments, separated by NULs.
    return (await readFile(`/proc/${pid}/cmdline`, "utf8")).replaceAll("\0", " ");
  } catch {
    // macOS has no /proc: `ps` tells it, and prints nothing for a process that is gone.
    return new Promise((resolve) =>
      execFile("ps", ["-o", "args=", "-p", String(pid)], (error, stdout) => resolve(error || !stdout.trim() ? undefined : stdout)),
    );
  }
}

/** Sends the process SIGTERM, then SIGKILL if it hasn't exited within the grace. */
async function killProcess(pid: number, graceMs: number): Promise<void> {
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const until = Date.now() + graceMs;
  while (alive() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
  if (alive()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone meanwhile.
    }
  }
}
