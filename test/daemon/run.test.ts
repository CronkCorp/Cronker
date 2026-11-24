import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { writeConfig } from "../../daemon/src/config.js";
import { runDaemon, type RunningDaemon } from "../../daemon/src/run.js";
import { minutes } from "../harness/clock.js";
import { createGitHubApp, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

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

async function ok(method: string, path: string, cookie: string, body?: unknown) {
  const response = await cronk.request(method, path, { cookie, body });
  expect(response.status, `${method} ${path}`).toBeLessThan(300);
  return response.status === 204 ? null : response.json();
}

/** Waits until the check passes, as the daemon works on its own time. */
async function eventually<T>(check: () => Promise<T | undefined | false>, timeoutMs = 10_000): Promise<T> {
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
async function localSetUp({ runLimit = 1 }: { runLimit?: number } = {}) {
  const { workspace } = await setUp(cronk);
  const ada = await signIn(cronk);
  const runner = await ok("POST", "/api/runners", ada, { name: "Laptop", kind: "local" });
  if (runLimit !== 1) await ok("PATCH", `/api/runners/${runner.id}`, ada, { runLimit });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "laptop" });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, ada, { runnerId: runner.id });
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const triage = project.statuses.find((s: { name: string }) => s.name === "Triage").id as string;

  const started = await (await cronk.request("POST", "/api/machines/pairings", { body: { name: "ada-laptop", os: "linux", daemonVersion: "0.3.0" } })).json();
  const machine = await ok("POST", "/api/machines/pairings/approve", ada, { userCode: started.userCode, runnerIds: [runner.id] });
  const paired = await (await cronk.request("POST", "/api/machines/pairings/poll", { body: { deviceCode: started.deviceCode } })).json();
  const configPath = join(home, "config.json");
  await writeConfig(configPath, { limit: 2, cronks: [{ url: cronk.url, machineId: machine.id, machineName: "ada-laptop", token: paired.machineToken }] });

  const bin = join(home, "bin");
  await mkdir(bin);
  const standIn = fileURLToPath(new URL("../harness/stand-in-claude.mjs", import.meta.url));
  await writeFile(join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${standIn}" "$@"\n`);
  await chmod(join(bin, "claude"), 0o755);
  const scratch = join(home, "scratch");
  await mkdir(scratch);
  const log = join(home, "claude.jsonl");
  await writeFile(log, "");

  const cache = join(home, "cache");
  const start = (
    mode: string,
    heartbeatMs?: number,
    more: { env?: NodeJS.ProcessEnv; remote?: string; lostCheckMs?: number } = {},
  ) => {
    daemon = runDaemon({
      configPath,
      print: () => {},
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STAND_IN_CLAUDE_LOG: log, STAND_IN_CLAUDE_MODE: mode, ...more.env },
      scratchRoot: scratch,
      cacheDir: cache,
      heartbeatMs,
      lostCheckMs: more.lostCheckMs,
      ...(more.remote ? { remoteFor: () => more.remote! } : {}),
    });
    return daemon;
  };
  const delegate = async (title: string) => {
    const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: triage });
    const [run] = await ok("GET", `/api/tickets/${ticket.id}/runs`, ada);
    return { ticket, run };
  };
  /** How the stand-in was run, once per run. */
  const runs = async () =>
    (await readFile(log, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const runState = (runId: string) => ok("GET", `/api/runs/${runId}`, ada);
  return { ada, workspace, project, start, delegate, runs, runState, scratch, cache };
}

const git = async (cwd: string, ...args: string[]) => (await promisify(execFile)("git", args, { cwd })).stdout.trim();

/**
 * The local set-up with the GitHub App installed on cronkcorp/cronker, listed by the Project, and a local bare git
 * repository standing in for it as the remote: `main` with one commit, and `feat/CRONK-1-started` one commit ahead.
 */
async function withRepository(options: { runLimit?: number } = {}) {
  const setup = await localSetUp(options);
  await createGitHubApp(cronk, setup.ada);
  const app = cronk.github.apps[0]!;
  const installation = cronk.github.install(app, "cronkcorp", ["cronker"]);
  const repository = installation.repositories[0]!;
  await ok("POST", `/api/projects/${setup.project.id}/repositories`, setup.ada, { id: repository.id });

  const remote = join(home, "cronker.git");
  await git(home, "init", "--bare", "--quiet", "--initial-branch=main", remote);
  const seed = join(home, "seed");
  await git(home, "init", "--quiet", "--initial-branch=main", seed);
  const commit = async (file: string) => {
    await writeFile(join(seed, file), `${file}\n`);
    await git(seed, "add", file);
    await git(seed, "-c", "user.name=Ada", "-c", "user.email=ada@example.com", "commit", "--quiet", "-m", file);
    return git(seed, "rev-parse", "HEAD");
  };
  const main = await commit("README.md");
  await git(seed, "push", "--quiet", remote, "main");
  await git(seed, "checkout", "--quiet", "-b", "feat/CRONK-1-started");
  const started = await commit("started.txt");
  await git(seed, "push", "--quiet", remote, "feat/CRONK-1-started");

  /** Opens a Pull Request of the Ticket's from the branch, as GitHub tells Cronk of it. */
  const openPullRequest = async (key: string, branch: string) => {
    const delivered = await cronk.github.deliver(app, "pull_request", {
      action: "opened",
      installation: { id: installation.id },
      repository: { id: repository.id, full_name: repository.fullName },
      pull_request: {
        id: 9001,
        number: 1,
        title: `${key}: carry on`,
        state: "open",
        draft: false,
        merged: false,
        merged_by: null,
        auto_merge: null,
        html_url: `https://github.com/${repository.fullName}/pull/1`,
        head: { ref: branch, sha: started },
        updated_at: "2026-01-01T09:00:00Z",
      },
    });
    expect(delivered.status).toBe(200);
  };
  const cloneUrl = `${cronk.github.url}/cronkcorp/cronker`;
  const startWith = (mode: string, more: { heartbeatMs?: number; env?: NodeJS.ProcessEnv; lostCheckMs?: number } = {}) =>
    setup.start(mode, more.heartbeatMs, { remote, lostCheckMs: more.lostCheckMs, env: { STAND_IN_CLAUDE_CREDENTIAL_URL: `${cloneUrl}.git`, ...more.env } });
  /** The installation tokens GitHub issued that are still good, by the test's clock. */
  const goodTokens = () => cronk.github.tokensIssued.filter((t) => t.expiresAt.getTime() > cronk.clock.now().getTime()).map((t) => t.token);
  return { ...setup, remote, main, started, openPullRequest, startWith, goodTokens };
}

const exists = (path: string) => access(path).then(() => true, () => false);

describe("cronk-runner run", () => {
  test("claims a delegated Run and runs claude with the Brief, model, stream-json and Cronk's MCP server; finish finishes the Run", async () => {
    const { ada, start, delegate, runs, runState, scratch } = await localSetUp();
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
      "--allowedTools",
      "mcp__cronk",
    ]);
    expect(ran.args).not.toContain("--strict-mcp-config");
    expect(ran.mcpConfig).toEqual({
      mcpServers: { cronk: { type: "http", url: `${cronk.url}/mcp`, headers: { authorization: expect.stringMatching(/^Bearer cronk_agent_/) } } },
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
    expect(failed.endReason).toBe("The session ended without calling `finish`: claude exited with code 3: stand-in claude gave up");
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
});

describe("a local Run's Repository", () => {
  test("is a worktree on the Ticket's branch when the remote has it, and the Run pushes with the App's token", async () => {
    const { delegate, runs, runState, scratch, cache, remote, started, openPullRequest, startWith, goodTokens } = await withRepository();
    const { run } = await delegate("Carry on");
    await openPullRequest("CRONK-1", "feat/CRONK-1-started");

    startWith("finish", { env: { STAND_IN_CLAUDE_PUSH: "feat/CRONK-1-started" } });

    await eventually(async () => (await runState(run.id)).state !== "running");
    expect((await runState(run.id)).endReason).toBe(null);
    const [ran] = await runs();
    expect(ran.repository).toEqual({ branch: "feat/CRONK-1-started", head: started, password: expect.any(String) });
    expect(goodTokens()).toContain(ran.repository.password);
    // The token never shows in argv, nor in the remote the bare clone keeps.
    expect(JSON.stringify(ran.args)).not.toContain(ran.repository.password);
    const pushed = await git(remote, "log", "-1", "--format=%s %P", "feat/CRONK-1-started");
    expect(pushed).toBe(`Stand-in work ${started}`);
    expect(await readdir(cache)).toEqual(["cronkcorp__cronker.git"]);
    expect(await git(join(cache, "cronkcorp__cronker.git"), "remote", "get-url", "origin")).toBe(remote);
    // Once the Run ended, its worktree is gone, and only the bare clone's own entry is left.
    await eventually(async () => (await readdir(scratch)).length === 0);
    expect((await git(join(cache, "cronkcorp__cronker.git"), "worktree", "list")).split("\n")).toHaveLength(1);
  });

  test("starts off the default branch for a Ticket without a branch, or whose branch the remote doesn't have", async () => {
    const { delegate, runs, runState, main, openPullRequest, startWith } = await withRepository();
    const { run: first } = await delegate("New work");
    startWith("finish");
    await eventually(async () => (await runState(first.id)).state === "finished");
    await daemon!.stop();
    const { run: second } = await delegate("Stale branch");
    await openPullRequest("CRONK-2", "feat/CRONK-2-never-pushed");
    startWith("finish");
    await eventually(async () => (await runState(second.id)).state === "finished");

    const ran = await runs();
    expect(ran.map((r) => r.repository)).toEqual([
      { branch: "HEAD", head: main, password: expect.any(String) },
      { branch: "HEAD", head: main, password: expect.any(String) },
    ]);
  });

  test("of two Runs at once is a separate worktree each, from one bare clone", async () => {
    const { delegate, runs, cache, startWith } = await withRepository({ runLimit: 2 });
    startWith("hang");

    const { run: first } = await delegate("One");
    const { run: second } = await delegate("Two");
    await eventually(async () => daemon!.held().length === 2 && (await runs()).length === 2);

    const [a, b] = await runs();
    expect(a.cwd).not.toBe(b.cwd);
    expect(await readdir(cache)).toEqual(["cronkcorp__cronker.git"]);
    const worktrees = await git(join(cache, "cronkcorp__cronker.git"), "worktree", "list", "--porcelain");
    const paths = worktrees.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
    expect(paths).toHaveLength(3);
    expect(daemon!.held().sort()).toEqual([first.id, second.id].sort());
  });

  test("is removed once the Run fails or is stopped", async () => {
    const { ada, delegate, runs, runState, startWith } = await withRepository();
    startWith("exit:3");
    const { run: failing } = await delegate("Give up");
    await eventually(async () => (await runState(failing.id)).state === "failed");
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
    // The session report may land after a first advance, counting as a call then.
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
    expect(await git(ran.cwd, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: null });

    await eventually(async () => !(await exists(ran.cwd)));
  });
});
