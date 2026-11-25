import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, expect, test } from "vitest";
import { setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";
import { openMachineStream, type OpenStream } from "../harness/stream.js";

/**
 * Seam 1: the Transcript of a Run on a Machine model (CRONK-159), converted from the OpenCode events its daemon
 * uploads, with the test playing the daemon over Cronk's HTTP API.
 *
 * The events in `fixtures/opencode-2.3.0.jsonl` follow the shape of `opencode run --format json`; they were written by
 * hand, not recorded from a real OpenCode 2.3.0, and should be replaced by a recording.
 */

let cronk: StartedCronk;
let streams: OpenStream[];
beforeEach(async () => {
  cronk = await startCronk();
  streams = [];
});
afterEach(async () => {
  for (const stream of streams) stream.close();
  await cronk?.stop();
});

type Options = { cookie?: string; body?: unknown; token?: string };

async function call(method: string, path: string, options: Options = {}) {
  const response = await cronk.request(method, path, {
    cookie: options.cookie,
    body: options.body,
    headers: options.token ? { authorization: `Bearer ${options.token}`, "x-cronk-runner-version": "0.6.0" } : {},
  });
  return { status: response.status, json: response.status === 204 ? null : await response.json() };
}

async function ok(method: string, path: string, options: Options = {}) {
  const response = await call(method, path, options);
  expect(response.status, `${method} ${path}: ${JSON.stringify(response.json)}`).toBeLessThan(300);
  return response.json;
}

const recorded = () => readFile(new URL("./fixtures/opencode-2.3.0.jsonl", import.meta.url), "utf8");

/**
 * Ada with a `local` Runner whose Triage label maps to the Machine model qwen, and a Machine offering it; `claimed`
 * delegates a Ticket and claims its Run, on qwen or, `onClaude`, on Claude, reporting the session as the daemon does.
 */
async function adaOnQwen() {
  const { workspace } = await setUp(cronk);
  const ada = await signIn(cronk);
  const runner = await ok("POST", "/api/runners", { cookie: ada, body: { name: "Laptop", kind: "local" } });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, { cookie: ada, body: { name: "laptop" } });
  await ok("PATCH", `/api/agents/${created.id}`, { cookie: ada, body: { runnerId: runner.id } });
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, { cookie: ada, body: { name: "Cronker", key: "CRONK" } });
  const triage = project.statuses.find((s: { name: string }) => s.name === "Triage").id as string;
  const started = await ok("POST", "/api/machines/pairings", { body: { name: "ada-gpu", os: "linux", daemonVersion: "0.6.0", limit: 2 } });
  await ok("POST", "/api/machines/pairings/approve", { cookie: ada, body: { userCode: started.userCode, runnerIds: [runner.id] } });
  const token = (await ok("POST", "/api/machines/pairings/poll", { body: { deviceCode: started.deviceCode } })).machineToken as string;
  streams.push(await openMachineStream(cronk, token));
  await ok("PUT", "/api/machine/announcement", { token, body: { claude: true, models: [{ name: "qwen", limit: 2, up: true }] } });

  const claimed = async (title: string, { onClaude = false } = {}) => {
    await ok("PATCH", `/api/runners/${runner.id}`, {
      cookie: ada,
      body: { machineModels: onClaude ? [] : [{ label: "haiku", model: "qwen" }] },
    });
    const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, { cookie: ada, body: { title } });
    await ok("PATCH", `/api/tickets/${ticket.id}`, { cookie: ada, body: { delegateId: created.id, statusId: triage } });
    const [run] = await ok("GET", `/api/tickets/${ticket.id}/runs`, { cookie: ada });
    const claim = await ok("POST", `/api/machine/runs/${run.id}/claim`, { token });
    expect(claim.machineModel ?? null).toBe(onClaude ? null : "qwen");
    await ok("POST", `/api/machine/runs/${run.id}/session`, { token, body: { sessionId: `ses_${run.id.slice(0, 8)}` } });
    return run.id as string;
  };
  /** Uploads the Run's transcript with the Machine token, as the daemon does. */
  const upload = async (runId: string, body: string) => {
    const response = await fetch(`${cronk.url}/api/machine/runs/${runId}/transcript`, {
      method: "PUT",
      headers: { "content-type": "application/x-ndjson", authorization: `Bearer ${token}` },
      body,
    });
    return { status: response.status, json: await response.json() };
  };
  const entries = async (transcriptId: string) =>
    (await ok("GET", `/api/transcripts/${transcriptId}/entries?limit=1000`, { cookie: ada })).entries;
  return { ada, claimed, upload, entries };
}

const none = { text: null, toolName: null, toolInput: null, toolResult: null, cut: false, cutParts: [] };

test("OpenCode's events become the Run's Transcript: the agent's messages and each tool call with its input and output or error, denied ones included", async () => {
  const { ada, claimed, upload, entries } = await adaOnQwen();
  const runId = await claimed("On qwen");

  const uploaded = await upload(runId, await recorded());

  expect(uploaded.status).toBe(201);
  expect((await ok("GET", `/api/runs/${runId}`, { cookie: ada })).transcriptId).toBe(uploaded.json.id);
  expect(await entries(uploaded.json.id)).toEqual([
    { ...none, position: 1, role: "assistant", text: "I'll read the Ticket, then look at the README.", at: "2025-11-25T14:40:00.900Z" },
    {
      ...none,
      position: 2,
      role: "assistant",
      toolName: "cronk_read_ticket",
      toolInput: { ticket: "CRONK-12" },
      toolResult: '{"key":"CRONK-12","title":"Fix the README\'s typo"}',
      at: "2025-11-25T14:40:01.200Z",
    },
    {
      ...none,
      position: 3,
      role: "assistant",
      toolName: "bash",
      toolInput: { command: "git log --oneline -1", description: "Show the last commit" },
      // Scrubbed as any Transcript is.
      toolResult: "212a180 Merge pull request #430 (token [scrubbed] leaked)\n",
      at: "2025-11-25T14:40:02.600Z",
    },
    {
      ...none,
      position: 4,
      role: "assistant",
      toolName: "read",
      toolInput: { filePath: "READMEE.md" },
      toolResult: "Error: File not found: READMEE.md",
      at: "2025-11-25T14:40:03.100Z",
    },
    {
      ...none,
      position: 5,
      role: "assistant",
      toolName: "bash",
      toolInput: { command: "curl https://example.com", description: "Fetch the example page" },
      toolResult: expect.stringMatching(/^Error: The user has specified a rule which prevents you from using this specific tool call/),
      at: "2025-11-25T14:40:03.500Z",
    },
    { ...none, position: 6, role: "assistant", text: "Fixed the typo and finished the Run.", at: "2025-11-25T14:40:04.200Z" },
    {
      ...none,
      position: 7,
      role: "system",
      text: "The model server stopped answering: connect ECONNREFUSED 127.0.0.1:11434",
      at: "2025-11-25T14:40:04.400Z",
    },
  ]);
});

test("each upload replaces the last, a half-written last line is left out, and a tool output over 20 KB is cut", async () => {
  const { claimed, upload, entries } = await adaOnQwen();
  const runId = await claimed("Long output");
  const events = (await recorded()).split("\n").filter(Boolean);

  // As it goes: the first three events, and half of the fourth still being written.
  const first = await upload(runId, `${events.slice(0, 3).join("\n")}\n${events[3]!.slice(0, 40)}`);
  expect(first.status).toBe(201);
  expect((await entries(first.json.id)).map((e: { text: string | null }) => e.text)).toEqual([
    "I'll read the Ticket, then look at the README.",
  ]);

  const long = JSON.stringify({
    type: "tool_use",
    timestamp: 1764081605000,
    sessionID: "ses_3f2a9c1e7ffeQx8bT1mN0pLk2R",
    part: { type: "tool", callID: "call_cat", tool: "bash", state: { status: "completed", input: { command: "cat big.log" }, output: "x".repeat(30_000) } },
  });
  const last = await upload(runId, `${events.join("\n")}\n${long}\n`);
  expect(last.status).toBe(200);
  expect(last.json.id).toBe(first.json.id);
  const all = await entries(last.json.id);
  expect(all).toHaveLength(8);
  expect(all.at(-1)).toMatchObject({ toolName: "bash", toolResult: "x".repeat(20 * 1024), cut: true, cutParts: ["toolResult"] });
});

test("redaction and deletion work on it as on any Transcript", async () => {
  const { ada, claimed, upload, entries } = await adaOnQwen();
  const runId = await claimed("Redact me");
  const { json: transcript } = await upload(runId, await recorded());

  await ok("POST", `/api/transcripts/${transcript.id}/redactions`, { cookie: ada, body: { text: "READMEE.md" } });
  const read = (await entries(transcript.id)).find((e: { toolName: string | null }) => e.toolName === "read");
  expect(read).toMatchObject({ toolInput: { filePath: "[redacted]" }, toolResult: "Error: File not found: [redacted]" });

  await ok("DELETE", `/api/transcripts/${transcript.id}`, { cookie: ada });
  const refused = await upload(runId, await recorded());
  expect(refused.status).toBe(410);
  expect(refused.json.error.code).toBe("transcript_deleted");
});

test("a Run on Claude is still converted from Claude Code's JSONL", async () => {
  const { claimed, upload, entries } = await adaOnQwen();
  const runId = await claimed("On Claude", { onClaude: true });
  const claudeLine = JSON.stringify({
    type: "assistant",
    timestamp: "2025-11-25T14:40:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "From Claude." }] },
  });

  const onClaude = await upload(runId, `${claudeLine}\n`);
  expect((await entries(onClaude.json.id)).map((e: { text: string | null }) => e.text)).toEqual(["From Claude."]);

  // OpenCode's events mean nothing to Claude Code's converter.
  const events = await upload(runId, await recorded());
  expect(events.json.entryCount).toBe(0);
});
