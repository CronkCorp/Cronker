import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  appendFile,
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
import {
  endRunRecord,
  eventsPathOf,
  historyDirOf,
  pruneRunRecords,
  writeRunRecord,
  type RunRecord,
} from "./history.js";
import { announcementOf, type Announcement } from "./models.js";
import { checkPrograms } from "./preflight.js";
import { openCode } from "./opencode.js";
import { claudeCode, type RunProgram } from "./program.js";
import { repositoryCache, type RunWorkspace } from "./repositories.js";

/**
 * `cronk-runner run`: the daemon's foreground service. For each paired Cronk it keeps the Machine's event stream open,
 * claims the Runs it announces while the Machine's limit has room, and runs each with its program (Claude Code, see
 * `program.ts`, or OpenCode for a Run on a Machine model, see `opencode.ts`) in a fresh scratch directory holding a
 * fresh worktree of each of its Repositories: reporting its session id, heartbeating it while it runs, uploading its
 * transcript as it goes, and reporting how the process ended, with the cost the program estimated.
 * The worktrees are removed once the Run ended, unless it is lost and may yet come back: then they are kept until
 * Cronk says otherwise.
 * A Run stopped in Cronk is killed and its stop confirmed. Each running process is recorded in the state directory,
 * so a daemon starting again kills those it left behind and reports their Runs ended.
 * A program that can resume (OpenCode) and exits cleanly while its Run still runs in Cronk is resumed once on the same
 * session with a reminder to call `finish`. Its Run is killed once past its time limit, counted from the first start,
 * and once the program's output has been nothing but retries of its server for five minutes. Each Run is also remembered in
 * the state directory's `history/` for a week after it ends, for `cronk-runner logs`.
 * About once a minute it reads the config again for its Machine models and checks each one's server, and it announces
 * what the Machine offers (whether it runs Claude, and each model's name, limit and whether it is up) to each Cronk on
 * connecting and whenever that changed.
 */

export interface RunOptions {
  configPath: string;
  print: (line: string) => void;
  /** The Claude Code executable, looked up on the `PATH` of `env`; `claude` when left out. */
  claude?: string;
  /** The OpenCode executable, looked up on the `PATH` of `env`; `opencode` when left out. */
  opencode?: string;
  /** The environment the program runs with; the daemon's own when left out. */
  env?: NodeJS.ProcessEnv;
  /** How often a running Run is heartbeated: every minute, well inside the lost-Run threshold, when left out. */
  heartbeatMs?: number;
  /** How long to wait before connecting again after a stream ends; grows up to a minute. */
  reconnectMs?: number;
  /** Where each Run's scratch directory is made; the OS's temporary directory when left out. */
  scratchRoot?: string;
  /** Where the running processes are recorded; `runs/` next to the config when left out. */
  stateDir?: string;
  /** How long a killed program has to exit after SIGTERM before it gets SIGKILL: ten seconds when left out. */
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
  /**
   * How often the config is read again for its Machine models and each one's server checked, announcing what changed
   * to every Cronk: every minute when left out.
   */
  modelCheckMs?: number;
  /** The time limit of every Run whose program has one, in place of its own: the Machine model's when left out. */
  timeLimitMs?: number;
  /** How long a program's output may be nothing but retries before its Run is killed: five minutes when left out. */
  retryWindowMs?: number;
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

/** One Run the daemon holds: its process, and how to stop it. */
interface HeldRun {
  cronkUrl: string;
  /** What its program is called, such as `claude`. */
  program: string;
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
  /** The program's identity for the Run, which the process's command line must carry to be killed. */
  identity?: string;
  /** What a daemon before `identity` recorded in its place: Claude Code's `--mcp-config` path. */
  mcpConfigPath?: string;
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
  /** The program the Runs on Claude run as. */
  const claude: RunProgram = claudeCode(options.claude);
  const scratchRoot = options.scratchRoot ?? tmpdir();
  const stateDir = options.stateDir ?? stateDirOf(options.configPath);
  const historyDir = historyDirOf(stateDir);
  const killGraceMs = options.killGraceMs ?? 10_000;
  const lostCheckMs = options.lostCheckMs ?? heartbeatMs;
  const branchWaitMs = options.branchWaitMs ?? 5 * 60_000;
  const retryWindowMs = options.retryWindowMs ?? 5 * 60_000;
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
  /** What the Machine offers, from the latest check of its Machine models; null before the first. */
  let offered: Announcement | null = null;
  /** The announcement each Cronk last accepted, as JSON, by address; dropped when its stream reconnects. */
  const announced = new Map<string, string>();
  /** The Cronks whose event stream is open now, by address. */
  const streaming = new Map<string, PairedCronk>();
  let checking = Promise.resolve();
  let modelTimer: NodeJS.Timeout | undefined;

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
    checkModels();
    modelTimer = setInterval(checkModels, options.modelCheckMs ?? 60_000);
    await pruneRunRecords(historyDir).catch(() => {});
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
        // Cronk hears what the Machine offers on every connection, as it may have restarted meanwhile.
        announced.delete(cronk.url);
        streaming.set(cronk.url, cronk);
        void checking.then(() => announceTo(cronk));
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
        streaming.delete(cronk.url);
      }
      if (stopped) return;
      await new Promise((resolve) => setTimeout(resolve, wait));
      wait = Math.min(wait * 2, 60_000);
    }
  }

  /**
   * Reads the config again for its Machine models, checks each one's server, and announces what the Machine offers to
   * each connected Cronk that hasn't accepted it yet. One check at a time.
   */
  function checkModels(): void {
    checking = checking.then(async () => {
      if (stopped) return;
      try {
        const { models } = await readConfig(options.configPath);
        // Checked each time, so installing, signing in to or removing a program is picked up within a check.
        const programs = await checkPrograms({ env, claude: options.claude, opencode: options.opencode });
        offered = await announcementOf(models, env, programs);
      } catch (error) {
        print(`Couldn't read the Machine models: ${(error as Error).message}`);
        return;
      }
      await Promise.all([...streaming.values()].map((cronk) => announceTo(cronk)));
    });
  }

  /** Tells the Cronk what the Machine offers, unless it already accepted the same announcement. */
  async function announceTo(cronk: PairedCronk): Promise<void> {
    if (!offered || stopped) return;
    const body = JSON.stringify(offered);
    if (announced.get(cronk.url) === body) return;
    try {
      await call(cronk.url, "PUT", "/api/machine/announcement", { headers: headers(cronk), body: offered });
      announced.set(cronk.url, body);
    } catch (error) {
      // A Cronk too old to know of Machine models: it counts this Machine as running Claude, which it does.
      if (error instanceof CronkError && error.status === 404) {
        announced.set(cronk.url, body);
        return;
      }
      print(`${cronk.url}: couldn't announce this Machine's models (${(error as Error).message}); trying again on the next check.`);
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
          // Its Runner is full, as when its limit was lowered, or its Machine model is on this Machine: it waits here,
          // while other Runs may go.
          if (
            error instanceof CronkError &&
            (error.code === "runner_limit_reached" || error.code === "machine_model_limit_reached")
          )
            continue;
          // Claimed by another Machine, ended meanwhile, or Cronk unreachable: the stream tells it again if it still waits.
          pending.delete(key);
          if (
            !(
              error instanceof CronkError &&
              ["run_not_claimable", "machine_model_missing", "machine_runs_no_claude"].includes(error.code ?? "")
            )
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
      print(`Run ${runId} was stopped in Cronk; stopping ${run.program}.`);
      run.kill();
      await run.ended;
    }
    await call(cronk.url, "POST", `/api/machine/runs/${runId}/stopped`, {
      headers: headers(cronk),
    }).catch(() => {});
  }

  /** Kills the program's processes a daemon before this one left running, and reports their Runs ended. */
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
      const identity = record.identity ?? record.mcpConfigPath;
      if (identity && (await commandLineOf(record.pid))?.includes(identity))
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
      await endRunRecord(historyDir, record.runId).catch(() => {});
      print(
        `Run ${record.runId}: killed what the last daemon left running; its Run ended (runner restarted).`,
      );
    }
  }

  /**
   * Runs a claimed Run's program in a fresh scratch directory with its worktrees, until it exits. The Run is
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
    let program = claude;
    held.set(runId, { cronkUrl: cronk.url, program: program.name, kill: () => kill(), ended });
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
    let child: ChildProcess;
    let identity: string;
    /** What the program first ran with, which a resume runs with again. */
    let args: string[];
    let programEnv: NodeJS.ProcessEnv;
    try {
      if (claimed.machineModel) {
        // Read now, as the config may have changed since the last check; a Machine model never falls back to Claude.
        const { models } = await readConfig(options.configPath);
        const model = models.find((m) => m.name === claimed.machineModel);
        if (!model)
          throw new Error(
            `it has no Machine model called ${claimed.machineModel} any more: add it again with \`cronk-runner model add ${claimed.machineModel}\``,
          );
        program = openCode(model, options.opencode);
        held.set(runId, { cronkUrl: cronk.url, program: program.name, kill: () => kill(), ended });
      }
      directory = await mkdtemp(join(scratchRoot, "cronk-run-"));
      workspace = await repositories.prepare(
        directory,
        claimed.repositories ?? [],
        env,
        { owner: `Run ${runId}`, signal: abort.signal, branchWaitMs },
      );
      if (abort.signal.aborted) throw new Error("it was stopped");
      const prepared = await program.prepare(claimed, directory, {
        base: env,
        workspace: workspace.env,
      });
      identity = prepared.identity;
      args = prepared.args;
      programEnv = prepared.env;
      if (abort.signal.aborted) throw new Error("it was stopped");
      print(
        `${claimed.ticketKey}: running Run ${runId} with ${claimed.machineModel ?? claimed.modelId}.`,
      );
      child = spawn(program.command, args, {
        cwd: workspace.cwd,
        env: programEnv,
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
    /** Records the program's running process, the resumed one in place of the first. */
    const recordProcess = (pid: number | undefined) =>
      pid === undefined
        ? Promise.resolve()
        : mkdir(stateDir, { recursive: true, mode: 0o700 })
            .then(() => {
              const record: ProcessRecord = {
                runId,
                cronkUrl: cronk.url,
                pid,
                directory: runDirectory,
                identity,
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
    // What `cronk-runner logs` reads of the Run, saved whole at each change, one write at a time.
    let history: RunRecord = {
      runId,
      ticketKey: claimed.ticketKey,
      cronkUrl: cronk.url,
      pid: child.pid ?? null,
      program: program.name === "opencode" ? "opencode" : "claude",
      sessionId: null,
      // A program whose output is its transcript has it recorded from the start.
      transcriptPath: program.records ? eventsPathOf(historyDir, runId) : null,
      startedAt: new Date().toISOString(),
      endedAt: null,
    };
    let historySaved: Promise<void> = Promise.resolve();
    const saveHistory = (changes: Partial<RunRecord>) =>
      (historySaved = historySaved.then(() => {
        history = { ...history, ...changes };
        return writeRunRecord(historyDir, history).catch((error: unknown) =>
          print(
            `${claimed.ticketKey}: couldn't record it for \`cronk-runner logs\`: ${(error as Error).message}`,
          ),
        );
      }));
    void saveHistory({});
    // The history first, so a daemon starting again after this one dies finds a recorded process's history to end.
    const firstPid = child.pid;
    let recorded = historySaved.then(() => recordProcess(firstPid));
    let lastError = "";
    let sessionId: string | null = null;
    let sessionReported: Promise<unknown> = Promise.resolve();
    /** What the program said the session cost, in US dollars; none if it ended without saying. */
    let costUsd: number | undefined;
    let denied: string[] = [];
    /** Since when the program's output has been nothing but retries; null while it gets further. */
    let retryingSince: number | null = null;
    const read = program.reader();
    // Each line of a program that `records` its output is appended to the Run's events file, one write at a time,
    // from every process of the Run: a resume's lines follow the first process's.
    const events = history.transcriptPath;
    let eventsWritten: Promise<void> = events
      ? mkdir(historyDir, { recursive: true, mode: 0o700 })
          .then(() => writeFile(events, "", { mode: 0o600, flag: "a" }))
          .catch((error: unknown) =>
            print(`${claimed.ticketKey}: couldn't record its events: ${(error as Error).message}`),
          )
      : Promise.resolve();
    /** Reads what a process of the program says, and ends the Run, or resumes it, once the process ended. */
    const attach = (spawned: ChildProcess) => {
      lastError = "";
      retryingSince = null;
      spawned.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
        const lines = chunk.trim().split("\n");
        lastError = lines.at(-1) ?? lastError;
      });
      createInterface({ input: spawned.stdout! }).on("line", (line) => {
        if (events)
          eventsWritten = eventsWritten.then(() =>
            appendFile(events, `${line}\n`).catch((error: unknown) =>
              print(`${claimed.ticketKey}: couldn't record its events: ${(error as Error).message}`),
            ),
          );
        const said = read(line);
        if (!sessionId && said.sessionId) {
          sessionId = said.sessionId;
          sessionReported = report("session", { sessionId }).catch(() => {});
          void saveHistory({ sessionId });
        }
        if (said.costUsd !== undefined) costUsd = said.costUsd;
        if (said.deniedTools) denied = said.deniedTools;
        retryingSince = said.retrying ? (retryingSince ?? Date.now()) : null;
      });
      spawned.on(
        "error",
        (error) => void end(`couldn't run ${program.command}: ${error.message}`),
      );
      spawned.on("close", (code, signal) => void closed(code, signal));
    };

    // The transcript follows the session: uploaded whole whenever its file changed, one upload at a time.
    let transcriptPath: string | null = events;
    let uploaded = "";
    let uploads = true;
    let uploading: Promise<void> = Promise.resolve();
    const uploadTranscript = () =>
      (uploading = uploading
        .then(async () => {
          if (!uploads || !sessionId) return;
          await eventsWritten;
          if (!transcriptPath) {
            transcriptPath = await program.transcript(env, sessionId);
            if (!transcriptPath) return;
            void saveHistory({ transcriptPath });
          }
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

    /** Whether the daemon is stopping the Run, so it isn't resumed, and why it killed it, if not for a stop. */
    let stopping = false;
    let killReason: string | undefined;
    let killedProcess: ChildProcess | undefined;
    kill = () => {
      stopping = true;
      const current = child;
      if (
        killedProcess === current ||
        current.exitCode !== null ||
        current.signalCode !== null
      )
        return;
      killedProcess = current;
      current.kill("SIGTERM");
      // A process that ignores SIGTERM, or hangs on it, doesn't outlive the grace.
      setTimeout(() => {
        if (current.exitCode === null && current.signalCode === null)
          current.kill("SIGKILL");
      }, killGraceMs).unref();
    };
    /** Kills the program for a reason its Run's end then reports. */
    const killFor = (reason: string) => {
      killReason ??= reason;
      kill();
    };
    // Counted from the first start, a resume included.
    const timeLimit =
      program.timeLimitMinutes === undefined
        ? undefined
        : setTimeout(
            () =>
              killFor(
                `it ran past its time limit of ${program.timeLimitMinutes} minutes`,
              ),
            options.timeLimitMs ?? program.timeLimitMinutes * 60_000,
          );
    // A program retrying a server that doesn't answer would otherwise wait for its time limit, or forever.
    const retryCheck = setInterval(
      () => {
        if (
          retryingSince !== null &&
          Date.now() - retryingSince >= retryWindowMs
        )
          killFor("its server stopped answering");
      },
      Math.min(10_000, Math.max(10, retryWindowMs / 10)),
    );
    let done = false;
    const end = async (reason: string) => {
      if (done) return;
      done = true;
      clearInterval(heartbeat);
      clearInterval(transcriptTimer);
      clearInterval(retryCheck);
      clearTimeout(timeLimit);
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
      await saveHistory({ endedAt: new Date().toISOString() });
      await pruneRunRecords(historyDir).catch(() => {});
      if (ended?.mayComeBack) {
        print(
          `${claimed.ticketKey}: Run ${runId} is lost in Cronk; keeping its worktree until it is stopped or ended.`,
        );
        keepWhileLost(report, cleanUp, runWorkspace, program.name);
      } else {
        await cleanUp();
      }
      held.delete(runId);
      print(`${claimed.ticketKey}: Run ${runId} ended: ${reason}.`);
      resolveEnded();
      claimWaiting();
    };
    let resumed = false;
    /**
     * Resumes a program that exited cleanly once, if it can be and its Run still runs in Cronk, as when a small model
     * ended its turn without calling `finish`; otherwise ends the Run with how the program ended.
     */
    const closed = async (code: number | null, signal: NodeJS.Signals | null) => {
      if (done) return;
      const how = signal
        ? `${program.name} was killed by ${signal}`
        : `${program.name} exited with code ${code}`;
      const session = sessionId;
      if (code === 0 && !stopping && !resumed && program.resume && session) {
        resumed = true;
        // One its agent finished, or a User stopped, is refused with `run_stopped`; any error counts the same.
        const running = await report("heartbeat").then(
          () => true,
          () => false,
        );
        if (running && !stopping && !done) {
          print(
            `${claimed.ticketKey}: Run ${runId} ended without calling finish; resuming its session once.`,
          );
          try {
            child = spawn(
              program.command,
              program.resume(args, session, runId),
              {
                cwd: runWorkspace.cwd,
                env: programEnv,
                stdio: ["ignore", "pipe", "pipe"],
              },
            );
          } catch (error) {
            void end(
              `couldn't resume ${program.command}: ${(error as Error).message}`,
            );
            return;
          }
          attach(child);
          const pid = child.pid;
          recorded = recorded.then(() => recordProcess(pid));
          void saveHistory({ pid: pid ?? null });
          return;
        }
      }
      void end(
        killReason ?? (code !== 0 && lastError ? `${how}: ${lastError}` : how),
      );
    };
    attach(child);
  }

  /** Asks Cronk about a lost Run until it says the Run won't come back, then cleans up. */
  function keepWhileLost(
    report: <T>(path: string, body?: unknown) => Promise<T>,
    cleanUp: () => Promise<void>,
    workspace: RunWorkspace,
    programName: string,
  ): void {
    const ask = () =>
      report<RunEnded>("end", { reason: `${programName} had exited` }).then(
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
      clearInterval(modelTimer);
      // Kept worktrees stay on disk, as the Runs may yet come back.
      for (const check of kept) clearInterval(check);
      kept.clear();
      for (const abort of aborts) abort.abort();
      await connections.catch(() => {});
      await checking;
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
