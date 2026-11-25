import { execFile, spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { writeConfig, type MachineModel } from "../../daemon/src/config.js";
import { defaultAllowedTools } from "../../server/runs/allowlist.js";
import { readRunRecord } from "../../daemon/src/history.js";
import { followRun } from "../../daemon/src/logs.js";
import { runDaemon, type RunningDaemon } from "../../daemon/src/run.js";
import { daemonVersion } from "../../daemon/src/version.js";
import { minutes } from "../harness/clock.js";
import { refusingCronk, tooOldMessage } from "../harness/refusing-cronk.js";
import { createGitHubApp, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";
import { openMachineStream } from "../harness/stream.js";

/**
 * Seam 2: `cronk-runner run` in-process against a real Cronk, with a scripted stand-in `claude` on its PATH that
 * records how it was run and finishes, exits early or hangs as the test says.
 */

let cronk: StartedCronk;
let home: string;
let daemon: RunningDaemon | undefined;
beforeEach(async () => {
  cronk = await startCronk();
  home = await mkdtemp(join(tmpdir(), "cronk-runner-run-"));
});
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  await cronk?.stop();
  await rm(home, { recursive: true, force: true });
});

async function ok(
  method: string,
  path: string,
  cookie: string,
  body?: unknown,
) {
  const response = await cronk.request(method, path, { cookie, body });
  expect(response.status, `${method} ${path}`).toBeLessThan(300);
  return response.status === 204 ? null : response.json();
}

/** Waits until the check passes, as the daemon works on its own time. */
async function eventually<T>(
  check: () => Promise<T | undefined | false>,
  timeoutMs = 10_000,
): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Ada with a `local` Runner and an Agent on it, the daemon's config pairing this Machine with Cronk to serve it, and
 * the stand-in `claude` on a PATH of its own; `delegate` files a Ticket and delegates it into Triage.
 */
async function localSetUp({
  limit = 2,
  runLimit = 1,
  models = [],
}: { limit?: number; runLimit?: number; models?: MachineModel[] } = {}) {
  const { workspace } = await setUp(cronk);
  const ada = await signIn(cronk);
  const runner = await ok("POST", "/api/runners", ada, {
    name: "Laptop",
    kind: "local",
  });
  if (runLimit !== 1)
    await ok("PATCH", `/api/runners/${runner.id}`, ada, { limit: runLimit });
  const created = await ok(
    "POST",
    `/api/workspaces/${workspace.id}/agents`,
    ada,
    { name: "laptop" },
  );
  const agent = await ok("PATCH", `/api/agents/${created.id}`, ada, {
    runnerId: runner.id,
  });
  const project = await ok(
    "POST",
    `/api/workspaces/${workspace.id}/projects`,
    ada,
    { name: "Cronker", key: "CRONK" },
  );
  const triage = project.statuses.find(
    (s: { name: string }) => s.name === "Triage",
  ).id as string;

  const started = await (
    await cronk.request("POST", "/api/machines/pairings", {
      body: { name: "ada-laptop", os: "linux", daemonVersion: "0.3.0" },
    })
  ).json();
  const machine = await ok("POST", "/api/machines/pairings/approve", ada, {
    userCode: started.userCode,
    runnerIds: [runner.id],
  });
  const paired = await (
    await cronk.request("POST", "/api/machines/pairings/poll", {
      body: { deviceCode: started.deviceCode },
    })
  ).json();
  const configPath = join(home, "config.json");
  await writeConfig(configPath, {
    limit,
    models,
    cronks: [
      {
        url: cronk.url,
        machineId: machine.id,
        machineName: "ada-laptop",
        token: paired.machineToken,
      },
    ],
  });

  const bin = join(home, "bin");
  await mkdir(bin);
  const standIn = fileURLToPath(
    new URL("../harness/stand-in-claude.mjs", import.meta.url),
  );
  await writeFile(
    join(bin, "claude"),
    `#!/bin/sh\nexec "${process.execPath}" "${standIn}" "$@"\n`,
  );
  await chmod(join(bin, "claude"), 0o755);
  const scratch = join(home, "scratch");
  await mkdir(scratch);
  const log = join(home, "claude.jsonl");
  await writeFile(log, "");

  const printed: string[] = [];
  const cache = join(home, "cache");
  const claudeConfig = join(home, "claude-config");
  const claudeEnv = (mode: string, more: NodeJS.ProcessEnv = {}) => ({
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    STAND_IN_CLAUDE_LOG: log,
    STAND_IN_CLAUDE_MODE: mode,
    CLAUDE_CONFIG_DIR: claudeConfig,
    ...more,
  });
  const start = (
    mode: string,
    heartbeatMs?: number,
    more: {
      env?: NodeJS.ProcessEnv;
      remote?: string;
      lostCheckMs?: number;
      killGraceMs?: number;
      branchWaitMs?: number;
    } = {},
  ) => {
    daemon = runDaemon({
      configPath,
      print: (line) => printed.push(line),
      env: claudeEnv(mode, more.env),
      scratchRoot: scratch,
      cacheDir: cache,
      heartbeatMs,
      lostCheckMs: more.lostCheckMs,
      killGraceMs: more.killGraceMs,
      branchWaitMs: more.branchWaitMs,
      ...(more.remote ? { remoteFor: () => more.remote! } : {}),
      transcriptMs: 50,
    });
    return daemon;
  };
  /** The Ticket's first Run, once it has one: a `local` Runner's Tickets wait until a Machine serving it connects. */
  const runOf = (ticketId: string) =>
    eventually(
      async () => (await ok("GET", `/api/tickets/${ticketId}/runs`, ada))[0],
    );
  /** Files a Ticket and delegates it into Triage, answering its Run once it has one: the daemon connects on its own time. */
  const delegate = async (title: string) => {
    const ticket = await ok(
      "POST",
      `/api/projects/${project.id}/tickets`,
      ada,
      { title },
    );
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, {
      delegateId: agent.id,
      statusId: triage,
    });
    return { ticket, run: await runOf(ticket.id) };
  };
  /** Files a Ticket and delegates it into Triage without waiting for its Run, as while no Machine is connected. */
  const delegateOffline = async (title: string) => {
    const ticket = await ok(
      "POST",
      `/api/projects/${project.id}/tickets`,
      ada,
      { title },
    );
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, {
      delegateId: agent.id,
      statusId: triage,
    });
    return ticket;
  };
  /** Turns the Triage Step's read-only setting on or off, keeping the rest of the Step. */
  const triageReadOnly = async (readOnly: boolean) => {
    const step = project.statuses.find((s: { id: string }) => s.id === triage).step;
    await ok("PUT", `/api/projects/${project.id}/statuses/${triage}/step`, ada, { ...step, readOnly });
  };
  /** How the stand-in was run, once per run; a line the stand-in is still writing waits for the next read. */
  const runs = async () => {
    const text = await readFile(log, "utf8");
    return text
      .slice(0, text.lastIndexOf("\n") + 1)
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  };
  const runState = (runId: string) => ok("GET", `/api/runs/${runId}`, ada);
  /** Lets a `wait-finish` stand-in go on to finish. */
  const go = () => writeFile(`${log}.go`, "");
  return {
    ada,
    agent,
    runner,
    workspace,
    project,
    machine,
    machineToken: paired.machineToken as string,
    configPath,
    claudeEnv,
    start,
    delegate,
    delegateOffline,
    triageReadOnly,
    runOf,
    runs,
    runState,
    scratch,
    cache,
    printed,
    go,
  };
}

const git = async (cwd: string, ...args: string[]) =>
  (await promisify(execFile)("git", args, { cwd })).stdout.trim();

/**
 * The local set-up with the GitHub App installed on cronkcorp/cronker, listed by the Project, and a local bare git
 * repository standing in for it as the remote: `main` with one commit, and `feat/CRONK-1-started` one commit ahead.
 */
async function withRepository(
  options: { limit?: number; runLimit?: number } = {},
) {
  const setup = await localSetUp(options);
  await createGitHubApp(cronk, setup.ada);
  const app = cronk.github.apps[0]!;
  const installation = cronk.github.install(app, "cronkcorp", ["cronker"]);
  const repository = installation.repositories[0]!;
  await ok(
    "POST",
    `/api/projects/${setup.project.id}/repositories`,
    setup.ada,
    { id: repository.id },
  );

  const remote = join(home, "cronker.git");
  await git(home, "init", "--bare", "--quiet", "--initial-branch=main", remote);
  const seed = join(home, "seed");
  await git(home, "init", "--quiet", "--initial-branch=main", seed);
  const commit = async (file: string) => {
    await writeFile(join(seed, file), `${file}\n`);
    await git(seed, "add", file);
    await git(
      seed,
      "-c",
      "user.name=Ada",
      "-c",
      "user.email=ada@example.com",
      "commit",
      "--quiet",
      "-m",
      file,
    );
    return git(seed, "rev-parse", "HEAD");
  };
  const main = await commit("README.md");
  await git(seed, "push", "--quiet", remote, "main");
  await git(seed, "checkout", "--quiet", "-b", "feat/CRONK-1-started");
  const started = await commit("started.txt");
  await git(seed, "push", "--quiet", remote, "feat/CRONK-1-started");

  /** Opens a Pull Request of the Ticket's from the branch, as GitHub tells Cronk of it. */
  const openPullRequest = async (key: string, branch: string, id = 9001) => {
    const delivered = await cronk.github.deliver(app, "pull_request", {
      action: "opened",
      installation: { id: installation.id },
      repository: { id: repository.id, full_name: repository.fullName },
      pull_request: {
        id,
        number: id - 9000,
        title: `${key}: carry on`,
        state: "open",
        draft: false,
        merged: false,
        merged_by: null,
        auto_merge: null,
        html_url: `https://github.com/${repository.fullName}/pull/${id - 9000}`,
        head: { ref: branch, sha: started },
        updated_at: "2026-01-01T09:00:00Z",
      },
    });
    expect(delivered.status).toBe(200);
  };
  const cloneUrl = `${cronk.github.url}/cronkcorp/cronker`;
  const startWith = (
    mode: string,
    more: {
      heartbeatMs?: number;
      env?: NodeJS.ProcessEnv;
      lostCheckMs?: number;
      branchWaitMs?: number;
    } = {},
  ) =>
    setup.start(mode, more.heartbeatMs, {
      remote,
      lostCheckMs: more.lostCheckMs,
      branchWaitMs: more.branchWaitMs,
      env: { STAND_IN_CLAUDE_CREDENTIAL_URL: `${cloneUrl}.git`, ...more.env },
    });
  /** The installation tokens GitHub issued that are still good, by the test's clock. */
  const goodTokens = () =>
    cronk.github.tokensIssued
      .filter((t) => t.expiresAt.getTime() > cronk.clock.now().getTime())
      .map((t) => t.token);
  /**
   * Files a Ticket, with a Pull Request from the branch when one is given, and delegates it straight into the Step of
   * the Status, without waiting for its Run.
   */
  const delegateInto = async (
    title: string,
    status: string,
    pullRequest?: { branch: string; id?: number },
  ) => {
    const ticket = await ok(
      "POST",
      `/api/projects/${setup.project.id}/tickets`,
      setup.ada,
      { title },
    );
    if (pullRequest)
      await openPullRequest(ticket.key, pullRequest.branch, pullRequest.id);
    await ok("PATCH", `/api/tickets/${ticket.id}`, setup.ada, {
      delegateId: setup.agent.id,
      statusId: statusOf(status),
    });
    return ticket;
  };
  const statusOf = (name: string) =>
    setup.project.statuses.find((s: { name: string }) => s.name === name)
      .id as string;
  /** The Ticket's Runs, oldest first. */
  const runsOf = async (ticketId: string) =>
    (
      (await ok("GET", `/api/tickets/${ticketId}/runs`, setup.ada)) as {
        id: string;
        startedAt: string;
      }[]
    ).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return {
    ...setup,
    delegateInto,
    statusOf,
    runsOf,
    remote,
    main,
    started,
    openPullRequest,
    startWith,
    goodTokens,
  };
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

describe("cronk-runner run", () => {
  test("claims a delegated Run and runs claude with the Brief, model, stream-json, Cronk's MCP server, edits accepted and the Runner's allowlist; finish finishes the Run", async () => {
    const { ada, start, delegate, triageReadOnly, runs, runState, scratch } =
      await localSetUp();
    await triageReadOnly(false);
    start("finish");

    const { run } = await delegate("Run me locally");

    const finished = await eventually(async () => {
      const state = await runState(run.id);
      return state.state === "finished" && state;
    });
    expect(finished.outcome).toBe("ready");
    const brief = await ok("GET", `/api/runs/${run.id}/brief`, ada);
    const [ran] = await runs();
    const mcpConfigPath = ran.args[ran.args.indexOf("--mcp-config") + 1];
    expect(ran.args).toEqual([
      "-p",
      brief.text,
      "--model",
      "claude-haiku-5-5",
      "--output-format",
      "stream-json",
      "--verbose",
      "--mcp-config",
      mcpConfigPath,
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      ...defaultAllowedTools,
    ]);
    expect(ran.args).not.toContain("--strict-mcp-config");
    expect(ran.mcpConfig).toEqual({
      mcpServers: {
        cronk: {
          type: "http",
          url: `${cronk.url}/mcp`,
          headers: {
            authorization: expect.stringMatching(/^Bearer cronk_agent_/),
          },
        },
      },
    });
    expect(ran.mcpConfigMode).toBe(0o600);
    // It ran in a fresh scratch directory, which is gone once the Run ended.
    expect(ran.cwd.startsWith(scratch)).toBe(true);
    await eventually(async () => (await readdir(scratch)).length === 0);
    expect(daemon!.held()).toEqual([]);
  });

  test("a claude that exits without finish fails the Run with the exit reason", async () => {
    const { start, delegate, runState } = await localSetUp();
    start("exit:3");

    const { run } = await delegate("Give up");

    const failed = await eventually(async () => {
      const state = await runState(run.id);
      return state.state === "failed" && state;
    });
    expect(failed.endReason).toBe(
      "The session ended without calling `finish`: claude exited with code 3: stand-in claude gave up",
    );
  });

  test("a Run claimed on a Machine model fails, saying this version can't run Machine models, and never runs claude", async () => {
    const { ada, runner, start, delegate, runs, runState } = await localSetUp({
      models: [
        // Set up though its server isn't there: it is announced, down.
        { name: "qwen", address: "http://127.0.0.1:9/v1", modelId: "qwen3.5:9b", contextSize: 65536, limit: 1, timeoutMinutes: 60 },
      ],
    });
    start("finish");
    await eventually(async () => {
      const [machine] = await ok("GET", "/api/machines", ada);
      return machine?.models.length === 1;
    });
    await ok("PATCH", `/api/runners/${runner.id}`, ada, { machineModels: [{ label: "haiku", model: "qwen" }] });

    const { run } = await delegate("On a Machine model");

    const failed = await eventually(async () => {
      const state = await runState(run.id);
      return state.state === "failed" && state;
    });
    expect(failed.machineModel).toBe("qwen");
    expect(failed.endReason).toContain("can't run Machine models");
    expect(await runs()).toEqual([]);
  });

  test("the edited allowlist is passed, Cronk's own tools always with it", async () => {
    const { ada, runner, start, delegate, triageReadOnly, runs, runState } =
      await localSetUp();
    await triageReadOnly(false);
    await ok("PATCH", `/api/runners/${runner.id}`, ada, {
      allowedTools: ["Bash(git:*)", "Bash(cargo test:*)"],
    });
    start("finish");

    const { run } = await delegate("Narrow");

    await eventually(async () => (await runState(run.id)).state === "finished");
    const [ran] = await runs();
    expect(ran.args.slice(ran.args.indexOf("--permission-mode"))).toEqual([
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Bash(git:*)",
      "Bash(cargo test:*)",
      "mcp__cronk",
    ]);
  });

  test("a Run of a read-only Step runs claude accepting no edits, the edit tools disallowed and out of the allowlist", async () => {
    const { ada, runner, start, delegate, runs, runState } = await localSetUp();
    await ok("PATCH", `/api/runners/${runner.id}`, ada, {
      allowedTools: ["Bash(git:*)", "Edit", "Write(src/**)", "Read"],
    });
    start("finish");

    // Triage is read-only on a new Project's board.
    const { run } = await delegate("Look only");

    await eventually(async () => (await runState(run.id)).state === "finished");
    const [ran] = await runs();
    expect(ran.args.slice(ran.args.indexOf("--permission-mode"))).toEqual([
      "--permission-mode",
      "default",
      "--disallowedTools",
      "Edit",
      "Write",
      "MultiEdit",
      "NotebookEdit",
      "--allowedTools",
      "Bash(git:*)",
      "Read",
      "mcp__cronk",
    ]);
    const brief = await ok("GET", `/api/runs/${run.id}/brief`, ada);
    expect(brief.text).toContain("This Step is read-only");
  });

  test("a Run of a read-only Step whose edit was refused fails saying the Step is read-only, not to widen the allowlist", async () => {
    const { start, delegate, runState } = await localSetUp();
    start("edit-denied:src/bug.ts");

    const { run } = await delegate("Fix it anyway");

    const failed = await eventually(async () => {
      const state = await runState(run.id);
      return state.state === "failed" && state;
    });
    expect(failed.endReason).toBe(
      "The session ended without calling `finish`: claude exited with code 0. Its Step is read-only, so its file " +
        "edits were refused: Edit.",
    );
  });

  test("a claude that ends on a tool outside the allowlist fails the Run naming it", async () => {
    const { start, delegate, runState } = await localSetUp();
    start("denied:npm publish");

    const { run } = await delegate("Publish it");

    const failed = await eventually(async () => {
      const state = await runState(run.id);
      return state.state === "failed" && state;
    });
    expect(failed.endReason).toBe(
      "The session ended without calling `finish`: claude exited with code 0. It needed a tool outside the Runner's " +
        "allowlist: Bash(npm publish); widen the allowlist and Retry.",
    );
  });

  test("heartbeats keep a working Run running past the lost-Run threshold, and a Run stopped in Cronk is killed", async () => {
    const { ada, start, delegate, runState, scratch } = await localSetUp();
    start("hang", 50);
    const { ticket, run } = await delegate("Think hard");
    await eventually(async () => daemon!.held().includes(run.id));

    for (let i = 0; i < 4; i++) {
      cronk.clock.advance(minutes(10));
      const now = cronk.clock.now().toISOString();
      await eventually(async () => (await runState(run.id)).lastCallAt === now);
      await cronk.checkForLostRuns();
    }
    expect((await runState(run.id)).state).toBe("running");

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: null });

    await eventually(async () => daemon!.held().length === 0);
    expect((await runState(run.id)).state).toBe("stopped");
    expect(await readdir(scratch)).toEqual([]);
  });

  test("holds a second Run beyond the Machine's limit until the first ends", async () => {
    const { ada, start, delegate, runState } = await localSetUp({
      limit: 1,
      runLimit: 2,
    });
    start("hang", 50);
    const { ticket, run: first } = await delegate("First");
    await eventually(async () => daemon!.held().includes(first.id));

    const { run: second } = await delegate("Second");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(daemon!.held()).toEqual([first.id]);
    expect((await runState(second.id)).state).toBe("running");

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: null });

    await eventually(async () => daemon!.held().includes(second.id));
    expect(daemon!.held()).toEqual([second.id]);
  });

  test("sends its version and the Machine's limit, which Cronk records", async () => {
    const { ada, start } = await localSetUp({ limit: 3 });
    start("finish");

    const machine = await eventually(async () => {
      const [shown] = await ok("GET", "/api/machines", ada);
      return shown.connected && shown;
    });
    expect(machine.limit).toBe(3);
    expect(machine.upgradeTo).toBeNull();
  });

  test("a Run stopped in Cronk is killed at once on the stream's word, even a claude ignoring SIGTERM, and its stop confirmed", async () => {
    const { ada, machineToken, start, delegate, runs, runState, scratch } =
      await localSetUp();
    // Heartbeats far apart: only the stream tells the daemon of the stop.
    start("hang-hard", 60_000, { killGraceMs: 200 });
    const { ticket, run } = await delegate("Stubborn");
    const [{ pid }] = await eventually(
      async () => (await runs()).length > 0 && runs(),
    );

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: null });

    await eventually(async () => daemon!.held().length === 0);
    expect(alive(pid)).toBe(false);
    expect((await runState(run.id)).state).toBe("stopped");
    expect(await readdir(scratch)).toEqual([]);
    // Confirmed, Cronk doesn't tell of the stop again.
    const stream = await openMachineStream(cronk, machineToken);
    await stream.expectQuiet();
    stream.close();
  });

  test("unpairing the Machine kills the Runs it holds", async () => {
    const { ada, machine, start, delegate, runs, runState, scratch } =
      await localSetUp();
    start("hang", 60_000);
    const { run } = await delegate("Unpaired");
    const [{ pid }] = await eventually(
      async () => (await runs()).length > 0 && runs(),
    );

    await ok("DELETE", `/api/machines/${machine.id}`, ada);

    await eventually(async () => daemon!.held().length === 0);
    expect(alive(pid)).toBe(false);
    expect((await runState(run.id)).state).toBe("stopped");
    expect(await readdir(scratch)).toEqual([]);
  });

  test("a daemon starting again kills the claude processes the last one left behind and fails their Runs: runner restarted", async () => {
    const { configPath, claudeEnv, start, delegate, runs, runState, scratch } =
      await localSetUp();
    // The last daemon, as its own process, killed without a chance to clean up.
    // Node itself, loading TypeScript through tsx, so SIGKILL reaches the daemon rather than a wrapper.
    const main = fileURLToPath(
      new URL("../../daemon/src/main.ts", import.meta.url),
    );
    const last = spawn(process.execPath, ["--import", "tsx", main, "run"], {
      env: {
        ...claudeEnv("hang-hard"),
        CRONK_RUNNER_CONFIG: configPath,
        TMPDIR: scratch,
      },
      stdio: "ignore",
    });
    try {
      const { run } = await delegate("Left behind");
      const [{ pid }] = await eventually(
        async () => (await runs()).length > 0 && runs(),
        20_000,
      );
      // The last daemon records its process once it has started it.
      const processRecords = async () =>
        (await readdir(join(home, "runs")).catch(() => [] as string[])).filter(
          (name) => name.endsWith(".json"),
        );
      await eventually(async () => (await processRecords()).length > 0);
      last.kill("SIGKILL");
      await new Promise((resolve) => last.once("exit", resolve));
      expect(alive(pid)).toBe(true);

      start("hang", 60_000, { killGraceMs: 200 });

      const failed = await eventually(async () => {
        const state = await runState(run.id);
        return state.state === "failed" && state;
      });
      expect(failed.endReason).toBe(
        "The session ended without calling `finish`: runner restarted",
      );
      await eventually(async () => !alive(pid));
      // tsx keeps its own cache in the last daemon's TMPDIR.
      expect(
        (await readdir(scratch)).filter((name) =>
          name.startsWith("cronk-run-"),
        ),
      ).toEqual([]);
      await eventually(async () => (await processRecords()).length === 0);
      // `cronk-runner logs` sees it ended, rather than running on.
      expect(
        (await readRunRecord(join(home, "runs", "history"), run.id))?.endedAt,
      ).toEqual(expect.any(String));
    } finally {
      last.kill("SIGKILL");
    }
  }, 30_000);

  test("uploads the session's transcript as it goes and once more at the end, and reports Claude Code's cost as an estimate", async () => {
    const { ada, start, delegate, runState, go } = await localSetUp();
    start("wait-finish");
    const { ticket, run } = await delegate("Show your work");

    // While the stand-in still runs, its transcript so far is the Run's Transcript in Cronk.
    const live = await eventually(
      async () => (await runState(run.id)).transcriptId as string | null,
    );
    expect(daemon!.held()).toEqual([run.id]);
    expect((await ok("GET", `/api/transcripts/${live}`, ada)).entryCount).toBe(
      1,
    );

    await go();
    await eventually(async () => daemon!.held().length === 0);

    const ended = await runState(run.id);
    expect(ended).toEqual(
      expect.objectContaining({
        state: "finished",
        transcriptId: live,
        cost: { amount: 137, currency: "USD", estimate: true },
      }),
    );
    const transcript = await ok("GET", `/api/transcripts/${live}`, ada);
    expect(transcript).toEqual(
      expect.objectContaining({ runId: run.id, entryCount: 2 }),
    );
    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).cost).toEqual([
      { amount: 137, currency: "USD", estimate: true },
    ]);
  });
});

describe("cronk-runner logs", () => {
  test("follows a Run the daemon runs from a second reader, by its Ticket's key, until it ends; its record is kept after", async () => {
    const { start, delegate, go, configPath } = await localSetUp();
    start("wait-finish");
    const { ticket, run } = await delegate("Show your work");
    const historyDir = join(home, "runs", "history");
    const recorded = await eventually(async () => {
      const record = await readRunRecord(historyDir, run.id);
      return record?.transcriptPath ? record : undefined;
    });
    expect(recorded).toEqual(
      expect.objectContaining({ ticketKey: ticket.key, cronkUrl: cronk.url, sessionId: expect.stringMatching(/^stand-in-/), endedAt: null }),
    );
    expect(configPath.startsWith(home)).toBe(true);

    const printed: string[] = [];
    const notes: string[] = [];
    const following = followRun(ticket.key.toLowerCase(), {
      historyDir,
      env: { CLAUDE_CONFIG_DIR: join(home, "claude-config") },
      print: (line) => printed.push(line),
      note: (line) => notes.push(line),
      pollMs: 20,
    });
    await go();
    expect(await following).toBe(0);
    expect(printed).toEqual([`${ticket.key}  Finished.`]);
    expect(notes.at(-1)).toBe(`${ticket.key}: Run ${run.id} ended.`);
    await eventually(async () => daemon!.held().length === 0);
    expect((await readRunRecord(historyDir, run.id))?.endedAt).toEqual(expect.any(String));
  });
});

describe("a daemon too old for Cronk", () => {
  test("stops connecting to it and says what to upgrade to", async () => {
    const tooOld = await refusingCronk();
    const configPath = join(home, "old.json");
    await writeConfig(configPath, {
      limit: 2,
      models: [],
      cronks: [
        {
          url: tooOld.url,
          machineId: "m",
          machineName: "ada-laptop",
          token: "cronk_machine_x",
        },
      ],
    });
    const printed: string[] = [];

    daemon = runDaemon({
      configPath,
      print: (line) => printed.push(line),
      reconnectMs: 10,
    });

    await eventually(async () =>
      printed.some((line) => line.includes("refused")),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(printed).toEqual([`${tooOld.url}: refused: ${tooOldMessage}`]);
    expect(tooOld.calls()).toEqual(1);
    expect(tooOld.headers()).toEqual(
      expect.objectContaining({
        "x-cronk-runner-version": daemonVersion,
        "x-cronk-runner-limit": "2",
      }),
    );
    await tooOld.close();
  });
});

/** Whether a process with the pid still runs (a zombie, killed but not yet reaped, counts as gone). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\S+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return true;
  }
}

describe("a local Run's Repository", () => {
  test("is a worktree on the Ticket's branch when the remote has it, and the Run pushes with the App's token", async () => {
    const {
      delegateOffline,
      runOf,
      runs,
      runState,
      scratch,
      cache,
      remote,
      started,
      openPullRequest,
      startWith,
      goodTokens,
    } = await withRepository();
    const ticket = await delegateOffline("Carry on");
    await openPullRequest("CRONK-1", "feat/CRONK-1-started");

    startWith("finish", {
      env: { STAND_IN_CLAUDE_PUSH: "feat/CRONK-1-started" },
    });
    const run = await runOf(ticket.id);

    await eventually(async () => (await runState(run.id)).state !== "running");
    expect((await runState(run.id)).endReason).toBe(null);
    const [ran] = await runs();
    expect(ran.repository).toEqual({
      branch: "feat/CRONK-1-started",
      head: started,
      password: expect.any(String),
    });
    expect(goodTokens()).toContain(ran.repository.password);
    // The token never shows in argv, nor in the remote the bare clone keeps.
    expect(JSON.stringify(ran.args)).not.toContain(ran.repository.password);
    const pushed = await git(
      remote,
      "log",
      "-1",
      "--format=%s %P",
      "feat/CRONK-1-started",
    );
    expect(pushed).toBe(`Stand-in work ${started}`);
    expect(await readdir(cache)).toEqual(["cronkcorp__cronker.git"]);
    expect(
      await git(
        join(cache, "cronkcorp__cronker.git"),
        "remote",
        "get-url",
        "origin",
      ),
    ).toBe(remote);
    // Once the Run ended, its worktree is gone, and only the bare clone's own entry is left.
    await eventually(async () => (await readdir(scratch)).length === 0);
    expect(
      (
        await git(join(cache, "cronkcorp__cronker.git"), "worktree", "list")
      ).split("\n"),
    ).toHaveLength(1);
  });

  test("starts off the default branch for a Ticket without a branch, or whose branch the remote doesn't have", async () => {
    const {
      delegate,
      delegateOffline,
      runOf,
      runs,
      runState,
      main,
      openPullRequest,
      startWith,
    } = await withRepository();
    startWith("finish");
    const { run: first } = await delegate("New work");
    await eventually(
      async () => (await runState(first.id)).state === "finished",
    );
    await daemon!.stop();
    const stale = await delegateOffline("Stale branch");
    await openPullRequest("CRONK-2", "feat/CRONK-2-never-pushed");
    startWith("finish");
    const second = await runOf(stale.id);
    await eventually(
      async () => (await runState(second.id)).state === "finished",
    );

    const ran = await runs();
    expect(ran.map((r) => r.repository)).toEqual([
      { branch: "HEAD", head: main, password: expect.any(String) },
      { branch: "HEAD", head: main, password: expect.any(String) },
    ]);
  });

  test("of two Runs at once is a separate worktree each, from one bare clone", async () => {
    const { delegate, runs, cache, startWith } = await withRepository({
      runLimit: 2,
    });
    startWith("hang");

    const { run: first } = await delegate("One");
    const { run: second } = await delegate("Two");
    await eventually(
      async () => daemon!.held().length === 2 && (await runs()).length === 2,
    );

    const [a, b] = await runs();
    expect(a.cwd).not.toBe(b.cwd);
    expect(await readdir(cache)).toEqual(["cronkcorp__cronker.git"]);
    const worktrees = await git(
      join(cache, "cronkcorp__cronker.git"),
      "worktree",
      "list",
      "--porcelain",
    );
    const paths = worktrees
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice(9));
    expect(paths).toHaveLength(3);
    expect(daemon!.held().sort()).toEqual([first.id, second.id].sort());
  });

  test("is removed once the Run fails or is stopped", async () => {
    const { ada, delegate, runs, runState, startWith } = await withRepository();
    startWith("exit:3");
    const { run: failing } = await delegate("Give up");
    await eventually(
      async () => (await runState(failing.id)).state === "failed",
    );
    const [failed] = await runs();
    await eventually(async () => !(await exists(failed.cwd)));
    await daemon!.stop();

    startWith("hang", { heartbeatMs: 50 });
    const { ticket, run: stopping } = await delegate("Take it back");
    await eventually(async () => (await runs()).length === 2);
    const [, hanging] = await runs();
    expect(await exists(hanging.cwd)).toBe(true);
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: null });

    await eventually(async () => daemon!.held().length === 0);
    expect((await runState(stopping.id)).state).toBe("stopped");
    expect(await exists(hanging.cwd)).toBe(false);
  });

  test("is kept while the Run is lost, and removed once its Ticket moves on", async () => {
    const { ada, delegate, runs, runState, startWith } = await withRepository();
    startWith("hang", { heartbeatMs: 60 * 60_000, lostCheckMs: 50 });
    const { ticket, run } = await delegate("Nap");
    await eventually(async () => (await runs()).length === 1);
    const [ran] = await runs();
    // The session report counts as a call and brings a lost Run back, so it must have landed before the Run goes lost:
    // landing after, it would leave the Run running when its process goes, and its worktree removed.
    const sessionPath = `/api/machine/runs/${run.id}/session`;
    await eventually(async () => {
      const sent = cronk.logs.filter(
        (l) => l.msg === "incoming request" && (l.req as { url?: string } | undefined)?.url === sessionPath,
      );
      return sent.some((s) =>
        cronk.logs.some((l) => l.msg === "request completed" && l.reqId === s.reqId),
      );
    });
    await eventually(async () => {
      cronk.clock.advance(minutes(40));
      await cronk.checkForLostRuns();
      return (await runState(run.id)).state === "lost";
    });

    // The process goes while the Run is lost: its worktree stays, as the Run may yet come back.
    process.kill(ran.pid, "SIGTERM");
    await eventually(async () => daemon!.held().length === 0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await exists(ran.cwd)).toBe(true);
    expect(await git(ran.cwd, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      "HEAD",
    );

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: null });

    await eventually(async () => !(await exists(ran.cwd)));
  });

  test("of a Run whose agent finished while its claude still exits is let go of before the next Run on its branch starts in it", async () => {
    const {
      delegateInto,
      runsOf,
      runs,
      runState,
      printed,
      openPullRequest,
      startWith,
    } = await withRepository({ runLimit: 2 });
    // The Investigate Run finishes with done, moving its Ticket to Implement, and its claude lingers before exiting.
    const ticket = await delegateInto("Carry on", "Investigate", {
      branch: "feat/CRONK-1-started",
    });
    startWith("finish,hang", {
      env: {
        STAND_IN_CLAUDE_OUTCOME: "done",
        STAND_IN_CLAUDE_LINGER_MS: "1000",
      },
    });

    const [first, second] = await eventually(async () => {
      const both = await runsOf(ticket.id);
      return both.length === 2 && both;
    });
    await eventually(async () => (await runs()).length === 2, 15_000);
    expect((await runState(first!.id)).state).toBe("finished");
    expect((await runState(second!.id)).state).toBe("running");
    const [firstRan, ran] = await runs();
    expect(ran.repository.branch).toBe("feat/CRONK-1-started");
    // It started once the first Run's process had exited and its worktree was removed.
    expect(alive(firstRan.pid)).toBe(false);
    expect(await exists(firstRan.cwd)).toBe(false);
    await eventually(async () => daemon!.held().join() === second!.id);
    expect(printed.join("\n")).not.toContain("couldn't start");
  }, 20_000);

  test("kept for a lost Run is let go of as soon as Cronk ended that Run and the next Run on its branch waits for it", async () => {
    const {
      ada,
      delegateInto,
      statusOf,
      runsOf,
      runs,
      runState,
      openPullRequest,
      startWith,
    } = await withRepository();
    // Lost checks far apart: only the waiting Run makes the daemon ask about the kept worktree.
    startWith("hang", { heartbeatMs: 60 * 60_000, lostCheckMs: 60 * 60_000 });
    const ticket = await delegateInto("Nap", "Investigate", {
      branch: "feat/CRONK-1-started",
    });
    await eventually(async () => (await runs()).length === 1);
    const [first] = await runsOf(ticket.id);
    const [ran] = await runs();
    await eventually(async () => {
      cronk.clock.advance(minutes(40));
      await cronk.checkForLostRuns();
      return (await runState(first!.id)).state === "lost";
    });
    process.kill(ran.pid, "SIGTERM");
    await eventually(async () => daemon!.held().length === 0);
    expect(await exists(ran.cwd)).toBe(true);

    // Moved on to Implement: Cronk ends the lost Run and starts the next on the same branch.
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, {
      statusId: statusOf("Implement"),
    });

    await eventually(async () => (await runs()).length === 2);
    const [, next] = await runs();
    expect(next.repository.branch).toBe("feat/CRONK-1-started");
    expect(await exists(ran.cwd)).toBe(false);
    const [, second] = await runsOf(ticket.id);
    expect((await runState(second!.id)).state).toBe("running");
  });

  test("held by another Run makes a Run on its branch wait, failing it after the wait's bound", async () => {
    const {
      delegateInto,
      runsOf,
      runState,
      printed,
      openPullRequest,
      startWith,
    } = await withRepository({ runLimit: 2 });
    startWith("hang", { branchWaitMs: 300 });
    const holding = await delegateInto("Holds the branch", "Investigate", {
      branch: "feat/CRONK-1-started",
    });
    const [holder] = await eventually(async () => {
      const found = await runsOf(holding.id);
      return found.length > 0 && daemon!.held().includes(found[0]!.id) && found;
    });
    await eventually(async () =>
      printed.some((l) => l.includes(`running Run ${holder!.id}`)),
    );

    const waiting = await delegateInto("Wants it too", "Investigate", {
      branch: "feat/CRONK-1-started",
      id: 9002,
    });
    const [waiter] = await eventually(async () => {
      const found = await runsOf(waiting.id);
      return found.length > 0 && found;
    });

    const failed = await eventually(async () => {
      const state = await runState(waiter!.id);
      return state.state === "failed" && state;
    });
    expect(failed.endReason).toContain(
      `the Machine couldn't start the Run: branch feat/CRONK-1-started is still checked out in the worktree of Run ${holder!.id}`,
    );
    await eventually(async () => daemon!.held().join() === holder!.id);
  });

  test("a Run waiting for its branch heartbeats, can be stopped, and doesn't hold up other Runs", async () => {
    const {
      ada,
      delegateInto,
      runsOf,
      runs,
      runState,
      printed,
      openPullRequest,
      startWith,
    } = await withRepository({ limit: 3, runLimit: 3 });
    startWith("hang", { heartbeatMs: 50 });
    const holding = await delegateInto("Holds the branch", "Investigate", {
      branch: "feat/CRONK-1-started",
    });
    const [holder] = await eventually(async () => {
      const found = await runsOf(holding.id);
      return found.length > 0 && found;
    });
    await eventually(async () =>
      printed.some((l) => l.includes(`running Run ${holder!.id}`)),
    );
    const waiting = await delegateInto("Wants it too", "Investigate", {
      branch: "feat/CRONK-1-started",
      id: 9002,
    });
    const [waiter] = await eventually(async () => {
      const found = await runsOf(waiting.id);
      return found.length > 0 && daemon!.held().includes(found[0]!.id) && found;
    });

    // An unrelated Run claimed after it starts meanwhile.
    const other = await delegateInto("Unrelated", "Investigate");
    await eventually(async () => (await runs()).length === 2);
    const [otherRun] = await runsOf(other.id);
    expect(daemon!.held().sort()).toEqual(
      [holder!.id, waiter!.id, otherRun!.id].sort(),
    );

    // Its heartbeats keep it running past the lost-Run threshold while it waits.
    cronk.clock.advance(minutes(40));
    const now = cronk.clock.now().toISOString();
    await eventually(
      async () => (await runState(waiter!.id)).lastCallAt === now,
    );
    await cronk.checkForLostRuns();
    expect((await runState(waiter!.id)).state).toBe("running");

    await ok("PATCH", `/api/tickets/${waiting.id}`, ada, { delegateId: null });

    await eventually(async () => !daemon!.held().includes(waiter!.id));
    expect((await runState(waiter!.id)).state).toBe("stopped");
    expect(daemon!.held().sort()).toEqual([holder!.id, otherRun!.id].sort());
    expect((await runs()).length).toBe(2);
  });
});
