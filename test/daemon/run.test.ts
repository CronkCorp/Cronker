import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { writeConfig } from "../../daemon/src/config.js";
import { defaultAllowedTools } from "../../server/runs/allowlist.js";
import { runDaemon, type RunningDaemon } from "../../daemon/src/run.js";
import { minutes } from "../harness/clock.js";
import { setUp, signIn } from "../harness/flows.js";
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
async function localSetUp() {
  const { workspace } = await setUp(cronk);
  const ada = await signIn(cronk);
  const runner = await ok("POST", "/api/runners", ada, { name: "Laptop", kind: "local" });
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

  const claudeConfig = join(home, "claude-config");
  const start = (mode: string, heartbeatMs?: number) => {
    daemon = runDaemon({
      configPath,
      print: () => {},
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        STAND_IN_CLAUDE_LOG: log,
        STAND_IN_CLAUDE_MODE: mode,
        CLAUDE_CONFIG_DIR: claudeConfig,
      },
      scratchRoot: scratch,
      heartbeatMs,
      transcriptMs: 50,
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
  /** Lets a `wait-finish` stand-in go on to finish. */
  const go = () => writeFile(`${log}.go`, "");
  return { ada, runner, start, delegate, runs, runState, scratch, go };
}

describe("cronk-runner run", () => {
  test("claims a delegated Run and runs claude with the Brief, model, stream-json, Cronk's MCP server, edits accepted and the Runner's allowlist; finish finishes the Run", async () => {
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
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      ...defaultAllowedTools,
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

  test("the edited allowlist is passed, Cronk's own tools always with it", async () => {
    const { ada, runner, start, delegate, runs, runState } = await localSetUp();
    await ok("PATCH", `/api/runners/${runner.id}`, ada, { allowedTools: ["Bash(git:*)", "Bash(cargo test:*)"] });
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

  test("uploads the session's transcript as it goes and once more at the end, and reports Claude Code's cost as an estimate", async () => {
    const { ada, start, delegate, runState, go } = await localSetUp();
    start("wait-finish");
    const { ticket, run } = await delegate("Show your work");

    // While the stand-in still runs, its transcript so far is the Run's Transcript in Cronk.
    const live = await eventually(async () => (await runState(run.id)).transcriptId as string | null);
    expect(daemon!.held()).toEqual([run.id]);
    expect((await ok("GET", `/api/transcripts/${live}`, ada)).entryCount).toBe(1);

    await go();
    await eventually(async () => daemon!.held().length === 0);

    const ended = await runState(run.id);
    expect(ended).toEqual(
      expect.objectContaining({ state: "finished", transcriptId: live, cost: { amount: 137, currency: "USD", estimate: true } }),
    );
    const transcript = await ok("GET", `/api/transcripts/${live}`, ada);
    expect(transcript).toEqual(expect.objectContaining({ runId: run.id, entryCount: 2 }));
    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).cost).toEqual([{ amount: 137, currency: "USD", estimate: true }]);
  });
});
