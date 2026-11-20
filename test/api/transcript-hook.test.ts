import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

let cronk: StartedCronk;
/** The session's temporary directory, where the hook keeps its copy of the script and when it last said the Run is alive. */
let sessionTmp: string;
beforeEach(async () => {
  cronk = await startCronk();
  sessionTmp = await mkdtemp(join(tmpdir(), "cronk-hook-test-"));
});
afterEach(async () => {
  await cronk?.stop();
  await rm(sessionTmp, { recursive: true, force: true });
});

interface Request {
  cookie?: string;
  headers?: Record<string, string>;
}

async function call(method: string, path: string, as: Request, body?: unknown) {
  const response = await cronk.request(method, path, { ...as, body });
  return { status: response.status, json: response.status === 204 ? null : await response.json() };
}

async function ok(method: string, path: string, as: Request, body?: unknown) {
  const response = await call(method, path, as, body);
  expect(response.status, `${method} ${path}: ${JSON.stringify(response.json)}`).toBeLessThan(300);
  return response.json;
}

const minutes = (n: number) => n * 60 * 1000;

/** Lines of a Claude Code JSONL transcript, as Claude Code writes them. */
const at = (second: number) => `2026-01-01T09:00:${String(second).padStart(2, "0")}.000Z`;
const userSays = (text: string, second = 0) => ({
  type: "user",
  uuid: `u-${second}`,
  timestamp: at(second),
  message: { role: "user", content: text },
});
const assistantSays = (text: string, second = 0) => ({
  type: "assistant",
  uuid: `a-${second}`,
  timestamp: at(second),
  message: { id: `msg-${second}`, role: "assistant", content: [{ type: "text", text }] },
});

/** Ada with her Agent `claude-max` on her fake Runner and a delegated Ticket, and the Transcript hook's settings. */
async function adaWithRunningRun() {
  const { workspace } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Make it so" });
  const runner = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, ada, { runnerId: runner.id });
  const hookToken = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "Transcript hook", access: "full" });
  const triage = project.statuses.find((s: { name: string }) => s.name === "Triage").id;
  await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id });
  await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: triage });
  const [run] = await ok("GET", `/api/tickets/${ticket.id}/runs`, ada);
  // The fake Runner's first session is `session_1`; in it, Claude Code on the web names itself `cse_1`.
  expect(run).toMatchObject({ state: "running", sessionUrl: "https://claude.ai/code/session_1" });
  return { workspace, ada, agent, ticket, run, hookToken };
}

/** The hook commands of the `settings.json` snippet Cronk gives a User to commit, by the event they run on. */
async function hookCommands(as: Request): Promise<Record<string, string>> {
  const { settings } = await ok("GET", "/api/transcript-hook", as);
  const commands: Record<string, string> = {};
  for (const [event, groups] of Object.entries(settings.hooks as Record<string, { hooks: { command: string }[] }[]>)) {
    commands[event] = groups[0]!.hooks[0]!.command;
  }
  return commands;
}

/**
 * Runs a hook command as Claude Code on the web does: through a shell, with the hook's input on stdin and the
 * cloud environment's variables (the token among them) in its environment.
 */
function runHook(command: string, input: unknown, env: Record<string, string>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("sh", ["-c", command], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: sessionTmp, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

/** Writes a JSONL transcript file as Claude Code keeps one, returning its path. */
async function transcriptFile(lines: unknown[]): Promise<string> {
  const path = join(sessionTmp, "transcript.jsonl");
  await writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
}

const stopInput = (transcriptPath: string) => ({
  session_id: "4f8e1c2a-local",
  transcript_path: transcriptPath,
  cwd: "/home/user/Cronker",
  hook_event_name: "Stop",
  stop_hook_active: false,
});

describe("the Transcript hook on Stop", () => {
  test("uploads the session's whole transcript, which becomes the Run's Transcript", async () => {
    const { ada, run, hookToken } = await adaWithRunningRun();
    const { Stop } = await hookCommands(ada);
    const path = await transcriptFile([userSays("Triage CRONK-1.", 1), assistantSays("Reading it.", 2)]);

    const hook = await runHook(Stop!, stopInput(path), {
      CRONK_TOKEN: hookToken.secret,
      CLAUDE_CODE_REMOTE_SESSION_ID: "cse_1",
    });

    expect(hook).toEqual({ code: 0, stdout: "", stderr: "" });
    const { transcriptId } = await ok("GET", `/api/runs/${run.id}`, ada);
    expect(await ok("GET", `/api/transcripts/${transcriptId}`, ada)).toMatchObject({ sessionId: "session_1", runId: run.id });
    const { entries } = await ok("GET", `/api/transcripts/${transcriptId}/entries`, ada);
    expect(entries.map((e: { text: string }) => e.text)).toEqual(["Triage CRONK-1.", "Reading it."]);
  });
});

describe("when the upload fails", () => {
  test("revoking the Transcript hook token refuses its uploads alone; the hook says why on stderr and exits 0", async () => {
    const { ada, agent, run, hookToken } = await adaWithRunningRun();
    const laptop = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "laptop", access: "full" });
    await ok("DELETE", `/api/agents/${agent.id}/tokens/${hookToken.token.id}`, ada);
    const { Stop } = await hookCommands(ada);
    const path = await transcriptFile([userSays("Triage CRONK-1.", 1)]);

    const refused = await runHook(Stop!, stopInput(path), { CRONK_TOKEN: hookToken.secret, CLAUDE_CODE_REMOTE_SESSION_ID: "cse_1" });

    expect(refused.code).toBe(0);
    expect(refused.stderr).toMatch(/^Cronk's Transcript hook: Cronk answered 401: .+\n$/);
    expect(await ok("GET", `/api/runs/${run.id}`, ada)).toMatchObject({ transcriptId: null });
    expect((await ok("GET", "/api/agent", { headers: { authorization: `Bearer ${laptop.secret}` } })).agent.id).toBe(agent.id);
  });

  test("a Cronk that can't be reached, or a missing token, never fails the agent's turn", async () => {
    const { ada, hookToken } = await adaWithRunningRun();
    const { Stop } = await hookCommands(ada);
    const path = await transcriptFile([userSays("Triage CRONK-1.", 1)]);
    await runHook(Stop!, stopInput(path), { CRONK_TOKEN: hookToken.secret, CLAUDE_CODE_REMOTE_SESSION_ID: "cse_1" });
    await cronk.stop();

    const unreachable = await runHook(Stop!, stopInput(path), { CRONK_TOKEN: hookToken.secret, CLAUDE_CODE_REMOTE_SESSION_ID: "cse_1" });
    const noToken = await runHook(Stop!, stopInput(path), { CLAUDE_CODE_REMOTE_SESSION_ID: "cse_1" });

    expect(unreachable.code).toBe(0);
    expect(unreachable.stderr).toMatch(/^Cronk's Transcript hook: .+\n$/);
    expect(noToken).toEqual({ code: 0, stdout: "", stderr: "Cronk's Transcript hook: CRONK_TOKEN is not set: add the Transcript hook token to the environment's variables.\n" });
  });
});

describe("keeping the Run alive", () => {
  test("each upload counts as a call naming its Run, so a Run whose session is working never becomes lost", async () => {
    const { ada, run, hookToken } = await adaWithRunningRun();
    const { Stop } = await hookCommands(ada);
    const path = await transcriptFile([userSays("Triage CRONK-1.", 1)]);
    const env = { CRONK_TOKEN: hookToken.secret, CLAUDE_CODE_REMOTE_SESSION_ID: "cse_1" };
    const state = async () => (await ok("GET", `/api/runs/${run.id}`, ada)).state;

    cronk.clock.advance(minutes(20));
    expect((await runHook(Stop!, stopInput(path), env)).stderr).toBe("");
    cronk.clock.advance(minutes(29));
    await cronk.checkForLostRuns();
    expect(await state()).toBe("running");

    cronk.clock.advance(minutes(1));
    await cronk.checkForLostRuns();
    expect(await state()).toBe("lost");
  });

  test("on PostToolUse the hook only tells Cronk the Run is alive, at most once every 5 minutes", async () => {
    const { ada, run, hookToken } = await adaWithRunningRun();
    const { PostToolUse } = await hookCommands(ada);
    const env = { CRONK_TOKEN: hookToken.secret, CLAUDE_CODE_REMOTE_SESSION_ID: "cse_1" };
    const toolUsed = {
      session_id: "4f8e1c2a-local",
      transcript_path: join(sessionTmp, "transcript.jsonl"),
      cwd: "/home/user/Cronker",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: { stdout: "1 passed" },
    };
    const lastCall = async () => (await ok("GET", `/api/runs/${run.id}`, ada)).lastCallAt;

    cronk.clock.advance(minutes(20));
    expect(await runHook(PostToolUse!, toolUsed, env)).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(await lastCall()).toBe("2026-01-01T09:20:00.000Z");
    // Nothing was uploaded: the ping only says the Run is alive.
    expect(await ok("GET", `/api/runs/${run.id}`, ada)).toMatchObject({ transcriptId: null });

    // Within 5 minutes of the last ping, by the session's own clock, the hook asks nothing of Cronk.
    cronk.clock.advance(minutes(2));
    expect(await runHook(PostToolUse!, toolUsed, env)).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(await lastCall()).toBe("2026-01-01T09:20:00.000Z");

    // Once 5 minutes have passed in the session, the next tool call pings again.
    const fiveMinutesAgo = new Date(Date.now() - minutes(5));
    for (const file of await readdir(sessionTmp, { recursive: true })) {
      if (file.endsWith(".alive")) await utimes(join(sessionTmp, file), fiveMinutesAgo, fiveMinutesAgo);
    }
    cronk.clock.advance(minutes(27));
    expect(await runHook(PostToolUse!, toolUsed, env)).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(await lastCall()).toBe("2026-01-01T09:49:00.000Z");
    cronk.clock.advance(minutes(29));
    await cronk.checkForLostRuns();
    expect((await ok("GET", `/api/runs/${run.id}`, ada)).state).toBe("running");
  });
});
