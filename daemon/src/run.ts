import { execFile, spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import {
  call,
  CronkError,
  machineHeaders,
  upload,
  type ClaimedRepository,
  type ClaimedRun,
  type HeartbeatAnswer,
  type RunEnded,
} from "./api.js";
import { readConfig, type PairedCronk } from "./config.js";
import { repositoryCache, type RunWorkspace } from "./repositories.js";

/**
 * `cronk-runner run`: the daemon's foreground service. For each paired Cronk it keeps the Machine's event stream open,
 * claims the Runs it announces while the Machine's limit has room, and runs each with `claude -p` in a fresh scratch
 * directory holding a fresh worktree of each of its Repositories: reporting its session id, heartbeating it while it
 * runs, uploading its transcript as it goes, and reporting how the process ended, with the cost Claude Code estimated.
 * The worktrees are removed once the Run ended, unless it is lost and may yet come back: then they are kept until
 * Cronk says otherwise.
 * A Run stopped in Cronk is killed and its stop confirmed. Each running process is recorded in the state directory,
 * so a daemon starting again kills those it left behind and reports their Runs ended.
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
  /**
   * Where the bare clones of the Repositories live: `cronk-runner/repositories` under `$XDG_CACHE_HOME`, else under
   * `~/.cache`, when left out.
   */
  cacheDir?: string;
  /** The remote a Repository is fetched from and pushed to; its clone URL when left out. Tests point it elsewhere. */
  remoteFor?: (repository: ClaimedRepository) => string;
  /** How often a lost Run's kept worktree is checked on; as often as heartbeats when left out. */
  lostCheckMs?: number;
  /** How often a running Run's transcript is uploaded, when it changed: every 10 seconds when left out. */
  transcriptMs?: number;
  /**
   * How long a Run waits for its start branch to be let go of by an earlier Run's worktree on the Machine before it
   * fails: five minutes when left out.
   */
  branchWaitMs?: number;
}

/** Where the bare clones live unless the options say otherwise. */
export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(
    env.XDG_CACHE_HOME || join(homedir(), ".cache"),
    "cronk-runner",
    "repositories",
  );
}

export interface RunningDaemon {
  /** The Runs it holds now, by id. */
  held(): string[];
  /** Ends the streams and kills the Runs' processes, waiting until each has reported its end. */
  stop(): Promise<void>;
}

/** The name Cronk's MCP server goes by in a Run's `--mcp-config`, so `mcp__cronk` allows its tools. */
const mcpServerName = "cronk";

/** Cronk's own MCP tools, always allowed: without them the agent can't call `finish`. */
const cronkTools = `mcp__${mcpServerName}`;

/**
 * The arguments `claude` runs a claimed Run with: edits accepted, and the Runner's allowlist, with Cronk's own tools
 * always in it, as the tools it may use without asking. In `-p` mode a tool call outside them is denied. A
 * Repository's committed Claude Code settings add their own allow rules, as Claude Code merges them.
 */
export function claudeArguments(
  claimed: ClaimedRun,
  mcpConfigPath: string,
): string[] {
  const allowed = [...new Set([...claimed.allowedTools, cronkTools])];
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
    "--permission-mode",
    "acceptEdits",
    // Last, one rule per argument: the flag takes every argument after it.
    "--allowedTools",
    ...allowed,
  ];
}

/** At most this many denied tools are reported with a Run's end, each at most `deniedToolLength` characters. */
const deniedToolsMax = 20;
const deniedToolLength = 200;

/**
 * The tool calls Claude Code denied, from its `result` message's `permission_denials`, as a person reads them: a
 * Bash call as `Bash(<command>)`, any other by its tool name.
 */
export function deniedTools(message: {
  permission_denials?: unknown;
}): string[] {
  if (!Array.isArray(message.permission_denials)) return [];
  const names = message.permission_denials.flatMap(
    (denial: { tool_name?: unknown; tool_input?: { command?: unknown } }) => {
      if (typeof denial?.tool_name !== "string" || !denial.tool_name.trim())
        return [];
      const command = denial.tool_input?.command;
      const name =
        denial.tool_name === "Bash" && typeof command === "string"
          ? `Bash(${command.trim()})`
          : denial.tool_name.trim();
      return [
        name.length > deniedToolLength
          ? `${name.slice(0, deniedToolLength - 1)}…`
          : name,
      ];
    },
  );
  return [...new Set(names)].slice(0, deniedToolsMax);
}

/**
 * Where Claude Code writes a session's transcript: `<config dir>/projects/<encoded cwd>/<session id>.jsonl`, the config
 * directory being `$CLAUDE_CONFIG_DIR` or `~/.claude`. The encoded cwd is looked up rather than computed, as a
 * symlinked temporary directory (macOS's `/var`) makes it differ from the path the daemon knows.
 */
export async function findTranscript(
  env: NodeJS.ProcessEnv,
  sessionId: string,
): Promise<string | null> {
  const projects = join(
    env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude"),
    "projects",
  );
  const directories = await readdir(projects).catch(() => [] as string[]);
  for (const directory of directories) {
    const path = join(projects, directory, `${sessionId}.jsonl`);
    if (
      await stat(path).then(
        (s) => s.isFile(),
        () => false,
      )
    )
      return path;
  }
  return null;
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
export const stateDirOf = (configPath: string): string =>
  join(dirname(configPath), "runs");

export function runDaemon(options: RunOptions): RunningDaemon {
  const {
    print,
    heartbeatMs = 60_000,
    reconnectMs = 1_000,
    transcriptMs = 10_000,
  } = options;
  const env = options.env ?? process.env;
  const claude = options.claude ?? "claude";
  const scratchRoot = options.scratchRoot ?? tmpdir();
  const stateDir = options.stateDir ?? stateDirOf(options.configPath);
  const killGraceMs = options.killGraceMs ?? 10_000;
  const lostCheckMs = options.lostCheckMs ?? heartbeatMs;
  const branchWaitMs = options.branchWaitMs ?? 5 * 60_000;
  const repositories = repositoryCache({
    directory: options.cacheDir ?? defaultCacheDir(env),
    remoteFor: options.remoteFor,
  });
  const held = new Map<string, HeldRun>();
  /** Lost Runs' kept worktrees, checked on until Cronk says the Run won't come back. */
  const kept = new Set<NodeJS.Timeout>();
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
    if (config.cronks.length === 0)
      print(
        "This Machine isn't paired with any Cronk yet: run `cronk-runner login <url>`.",
      );
    return config;
  });
  const connections = configRead.then(async (config) => {
    await killLeftovers(config.cronks);
    await Promise.all(config.cronks.map((cronk) => connect(cronk)));
  });
  connections.catch((error: unknown) =>
    print(`Couldn't start: ${(error as Error).message}`),
  );

  /** Keeps the Cronk's event stream open until the daemon stops or the Machine is unpaired, reconnecting with backoff. */
  async function connect(cronk: PairedCronk): Promise<void> {
    let wait = reconnectMs;
    while (!stopped) {
      const abort = new AbortController();
      aborts.add(abort);
      try {
        const response = await fetch(`${cronk.url}/api/machine/events`, {
          headers: {
            ...machineHeaders(cronk.token, limit),
            accept: "text/event-stream",
          },
          signal: abort.signal,
        });
        if (response.status === 401) {
          print(
            `${cronk.url}: this Machine was unpaired: run \`cronk-runner login ${cronk.url}\` again.`,
          );
          // Cronk stopped the Runs it held; nothing keeps running for a Cronk it can no longer reach.
          const ending = [...held.values()].filter(
            (run) => run.cronkUrl === cronk.url,
          );
          for (const run of ending) run.kill();
          await Promise.all(ending.map((run) => run.ended));
          return;
        }
        if (response.status === 426) {
          // Connecting again won't help until the daemon is upgraded.
          const refusal = (await response.json().catch(() => ({}))) as {
            error?: { message?: string };
          };
          print(
            `${cronk.url}: refused: ${refusal.error?.message ?? "this cronk-runner is too old for it; upgrade it."}`,
          );
          return;
        }
        if (!response.ok || !response.body)
          throw new Error(`Cronk answered ${response.status}.`);
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
        print(
          `${cronk.url}: lost the connection (${(error as Error).message}); connecting again.`,
        );
      } finally {
        aborts.delete(abort);
      }
      if (stopped) return;
      await new Promise((resolve) => setTimeout(resolve, wait));
      wait = Math.min(wait * 2, 60_000);
    }
  }

  /**
   * Claims waiting Runs, one at a time, while the Machine's limit has room. Each claimed Run starts on its own, so one
   * waiting for an earlier Run's worktree doesn't hold up the next claim.
   */
  function claimWaiting(): void {
    claiming = claiming.then(async () => {
      for (const [key, { cronk, runId }] of pending) {
        if (stopped || held.size >= limit) return;
        let claimed: ClaimedRun;
        try {
          claimed = await call<ClaimedRun>(
            cronk.url,
            "POST",
            `/api/machine/runs/${runId}/claim`,
            { headers: headers(cronk) },
          );
        } catch (error) {
          // Full on Cronk's count (it counts Runs of every daemon of this Machine): it waits for room here.
          if (
            error instanceof CronkError &&
            error.code === "machine_limit_reached"
          )
            return;
          // Its Runner is full, as when its limit was lowered: it waits here, while other Runners' Runs may go.
          if (
            error instanceof CronkError &&
            error.code === "runner_limit_reached"
          )
            continue;
          // Claimed by another Machine, ended meanwhile, or Cronk unreachable: the stream tells it again if it still waits.
          pending.delete(key);
          if (
            !(error instanceof CronkError && error.code === "run_not_claimable")
          ) {
            print(
              `${cronk.url}: couldn't claim Run ${runId}: ${(error as Error).message}`,
            );
          }
          continue;
        }
        pending.delete(key);
        void start(cronk, claimed);
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
    await call(cronk.url, "POST", `/api/machine/runs/${runId}/stopped`, {
      headers: headers(cronk),
    }).catch(() => {});
  }

  /** Kills the `claude` processes a daemon before this one left running, and reports their Runs ended. */
  async function killLeftovers(cronks: PairedCronk[]): Promise<void> {
    let names: string[];
    try {
      names = (await readdir(stateDir)).filter((name) =>
        name.endsWith(".json"),
      );
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
      if ((await commandLineOf(record.pid))?.includes(record.mcpConfigPath))
        await killProcess(record.pid, killGraceMs);
      await rm(record.directory, { recursive: true, force: true });
      const cronk = cronks.find((c) => c.url === record.cronkUrl);
      if (cronk) {
        // A Run that ended meanwhile, or isn't this Machine's any more, is left as it is.
        await call(cronk.url, "POST", `/api/machine/runs/${record.runId}/end`, {
          headers: headers(cronk),
          body: { reason: "runner restarted" },
        }).catch(() => {});
      }
      await rm(path, { force: true });
      print(
        `Run ${record.runId}: killed what the last daemon left running; its Run ended (runner restarted).`,
      );
    }
  }

  /**
   * Runs a claimed Run's `claude` process in a fresh scratch directory with its worktrees, until it exits. The Run is
   * held, heartbeated and stoppable from the claim on, as making its worktrees may wait for an earlier Run's.
   */
  async function start(cronk: PairedCronk, claimed: ClaimedRun): Promise<void> {
    const { runId } = claimed;
    const report = <T = unknown>(path: string, body?: unknown) =>
      call<T>(cronk.url, "POST", `/api/machine/runs/${runId}/${path}`, {
        headers: headers(cronk),
        body,
      });
    let resolveEnded!: () => void;
    const ended = new Promise<void>((resolve) => (resolveEnded = resolve));
    /** Stops the Run before its process is spawned, as while it waits for its worktrees. */
    const abort = new AbortController();
    let kill = () => abort.abort();
    held.set(runId, { cronkUrl: cronk.url, kill: () => kill(), ended });
    let workspace: RunWorkspace | undefined;
    const heartbeat = setInterval(() => {
      report<HeartbeatAnswer>("heartbeat")
        .then(
          (answer) => workspace?.refresh(answer.repositories ?? []),
          (error: unknown) => {
            // Cronk no longer runs the Run, as when a User took its Ticket away: its process stops too.
            if (
              error instanceof CronkError &&
              (error.code === "run_stopped" || error.status === 404)
            )
              void stopRun(cronk, runId);
          },
        )
        .catch((error: unknown) =>
          print(
            `${claimed.ticketKey}: couldn't write fresh GitHub tokens: ${(error as Error).message}`,
          ),
        );
    }, heartbeatMs);

    let directory: string | undefined;
    let child: ReturnType<typeof spawn>;
    let mcpConfigPath: string;
    try {
      directory = await mkdtemp(join(scratchRoot, "cronk-run-"));
      workspace = await repositories.prepare(
        directory,
        claimed.repositories ?? [],
        env,
        { owner: `Run ${runId}`, signal: abort.signal, branchWaitMs },
      );
      if (abort.signal.aborted) throw new Error("it was stopped");
      // The Run's token goes in a file only its User reads, outside the directory the agent works in, never in argv.
      mcpConfigPath = join(directory, "mcp.json");
      const mcpConfig = {
        mcpServers: {
          [mcpServerName]: {
            type: "http",
            url: claimed.mcpUrl,
            headers: { authorization: `Bearer ${claimed.token}` },
          },
        },
      };
      await writeFile(mcpConfigPath, JSON.stringify(mcpConfig), {
        mode: 0o600,
      });
      if (abort.signal.aborted) throw new Error("it was stopped");
      print(
        `${claimed.ticketKey}: running Run ${runId} with ${claimed.modelId}.`,
      );
      child = spawn(claude, claudeArguments(claimed, mcpConfigPath), {
        cwd: workspace.cwd,
        env: { ...env, ...workspace.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      clearInterval(heartbeat);
      await workspace?.remove().catch(() => {});
      if (directory) await rm(directory, { recursive: true, force: true });
      const reason = `the Machine couldn't start the Run: ${(error as Error).message}`;
      await report("end", { reason }).catch(() => {});
      print(`${claimed.ticketKey}: ${reason}`);
      held.delete(runId);
      resolveEnded();
      claimWaiting();
      return;
    }
    const runDirectory = directory;
    const runWorkspace = workspace;
    const cleanUp = async () => {
      await runWorkspace.remove();
      await rm(runDirectory, { recursive: true, force: true });
    };

    const recordPath = join(stateDir, `${runId}.json`);
    const recorded =
      child.pid === undefined
        ? Promise.resolve()
        : mkdir(stateDir, { recursive: true, mode: 0o700 })
            .then(() => {
              const record: ProcessRecord = {
                runId,
                cronkUrl: cronk.url,
                pid: child.pid!,
                directory: runDirectory,
                mcpConfigPath,
              };
              return writeFile(recordPath, JSON.stringify(record), {
                mode: 0o600,
              });
            })
            .catch((error: unknown) =>
              print(
                `${claimed.ticketKey}: couldn't record its process: ${(error as Error).message}`,
              ),
            );
    let lastError = "";
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
      const lines = chunk.trim().split("\n");
      lastError = lines.at(-1) ?? lastError;
    });
    let sessionId: string | null = null;
    let sessionReported: Promise<unknown> = Promise.resolve();
    /** What Claude Code's `result` message said the session cost, in US dollars; none if it ended without one. */
    let costUsd: number | undefined;
    let denied: string[] = [];
    createInterface({ input: child.stdout! }).on("line", (line) => {
      let message: {
        type?: unknown;
        subtype?: unknown;
        session_id?: unknown;
        total_cost_usd?: unknown;
        permission_denials?: unknown;
      };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        return;
      }
      if (
        !sessionId &&
        message.type === "system" &&
        message.subtype === "init" &&
        typeof message.session_id === "string"
      ) {
        sessionId = message.session_id;
        sessionReported = report("session", { sessionId }).catch(() => {});
      }
      if (
        message.type === "result" &&
        typeof message.total_cost_usd === "number" &&
        Number.isFinite(message.total_cost_usd)
      ) {
        costUsd = Math.max(0, message.total_cost_usd);
      }
      if (message.type === "result") denied = deniedTools(message);
    });

    // The transcript follows the session: uploaded whole whenever its file changed, one upload at a time.
    let transcriptPath: string | null = null;
    let uploaded = "";
    let uploads = true;
    let uploading: Promise<void> = Promise.resolve();
    const uploadTranscript = () =>
      (uploading = uploading
        .then(async () => {
          if (!uploads || !sessionId) return;
          transcriptPath ??= await findTranscript(env, sessionId);
          if (!transcriptPath) return;
          const file = await stat(transcriptPath).catch(() => null);
          const version = file ? `${file.size} ${file.mtimeMs}` : "";
          if (!file || version === uploaded) return;
          const body = await readFile(transcriptPath, "utf8");
          await sessionReported;
          try {
            await upload(
              cronk.url,
              "PUT",
              `/api/machine/runs/${runId}/transcript`,
              {
                body,
                contentType: "application/x-ndjson",
                headers: headers(cronk),
              },
            );
            uploaded = version;
          } catch (error) {
            // A User deleted its Transcript, or the Machine no longer holds the Run: later uploads would be refused too.
            if (
              error instanceof CronkError &&
              (error.code === "transcript_deleted" ||
                error.status === 404 ||
                error.status === 401)
            ) {
              uploads = false;
            } else {
              print(
                `${claimed.ticketKey}: couldn't upload its transcript: ${(error as Error).message}`,
              );
            }
          }
        })
        .catch((error: unknown) =>
          print(
            `${claimed.ticketKey}: couldn't read its transcript: ${(error as Error).message}`,
          ),
        ));
    const transcriptTimer = setInterval(
      () => void uploadTranscript(),
      transcriptMs,
    );

    let killed = false;
    kill = () => {
      if (killed || child.exitCode !== null || child.signalCode !== null)
        return;
      killed = true;
      child.kill("SIGTERM");
      // A process that ignores SIGTERM, or hangs on it, doesn't outlive the grace.
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }, killGraceMs).unref();
    };
    let done = false;
    const end = async (reason: string) => {
      if (done) return;
      done = true;
      clearInterval(heartbeat);
      clearInterval(transcriptTimer);
      // Once more after the process ended, so the Transcript in Cronk is complete.
      await uploadTranscript();
      // A Run its agent finished ended already in Cronk, which then leaves it as it is; the cost is recorded either way.
      const ended = await report<RunEnded>("end", {
        reason,
        ...(costUsd === undefined ? {} : { costUsd }),
        ...(denied.length ? { deniedTools: denied } : {}),
      }).catch((error: unknown) => {
        print(
          `${claimed.ticketKey}: couldn't report its end: ${(error as Error).message}`,
        );
        return undefined;
      });
      // The process is gone, whatever happens to its worktree: a daemon starting again has nothing of it to kill.
      await recorded;
      await rm(recordPath, { force: true });
      if (ended?.mayComeBack) {
        print(
          `${claimed.ticketKey}: Run ${runId} is lost in Cronk; keeping its worktree until it is stopped or ended.`,
        );
        keepWhileLost(report, cleanUp, runWorkspace);
      } else {
        await cleanUp();
      }
      held.delete(runId);
      print(`${claimed.ticketKey}: Run ${runId} ended: ${reason}.`);
      resolveEnded();
      claimWaiting();
    };
    child.on(
      "error",
      (error) => void end(`couldn't run ${claude}: ${error.message}`),
    );
    child.on("close", (code, signal) => {
      const how = signal
        ? `claude was killed by ${signal}`
        : `claude exited with code ${code}`;
      void end(code !== 0 && lastError ? `${how}: ${lastError}` : how);
    });
  }

  /** Asks Cronk about a lost Run until it says the Run won't come back, then cleans up. */
  function keepWhileLost(
    report: <T>(path: string, body?: unknown) => Promise<T>,
    cleanUp: () => Promise<void>,
    workspace: RunWorkspace,
  ): void {
    const ask = () =>
      report<RunEnded>("end", { reason: "claude had exited" }).then(
        async (ended) => {
          if (ended.mayComeBack || !kept.has(check)) return;
          kept.delete(check);
          clearInterval(check);
          await cleanUp();
        },
        async (error: unknown) => {
          // Unpaired, or the Run is gone: nothing will come back for it.
          if (
            error instanceof CronkError &&
            (error.status === 401 || error.status === 404) &&
            kept.delete(check)
          ) {
            clearInterval(check);
            await cleanUp();
          }
        },
      );
    const check = setInterval(ask, lostCheckMs);
    kept.add(check);
    // A Run waiting for the kept worktree's branch, as a next Run on the Ticket once Cronk ended the lost one: ask now.
    workspace.onWaitedOn(ask);
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
async function* serverSentEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ type: string; data: string }> {
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
    return (await readFile(`/proc/${pid}/cmdline`, "utf8")).replaceAll(
      "\0",
      " ",
    );
  } catch {
    // macOS has no /proc: `ps` tells it, and prints nothing for a process that is gone.
    return new Promise((resolve) =>
      execFile("ps", ["-o", "args=", "-p", String(pid)], (error, stdout) =>
        resolve(error || !stdout.trim() ? undefined : stdout),
      ),
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
  while (alive() && Date.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 50));
  if (alive()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone meanwhile.
    }
  }
}
