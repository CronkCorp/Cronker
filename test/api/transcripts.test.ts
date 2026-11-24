import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";
import { openStream } from "../harness/stream.js";

let cronk: StartedCronk;
beforeEach(async () => {
  cronk = await startCronk();
});
afterEach(async () => {
  await cronk?.stop();
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

/** Uploads a Claude Code transcript as the hook does: the JSONL file as it is, for its session. */
async function upload(sessionId: string, lines: unknown[], as: Request) {
  const response = await fetch(`${cronk.url}/api/transcripts/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PUT",
    headers: { "content-type": "application/x-ndjson", ...as.headers },
    body: lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n",
  });
  return { status: response.status, json: await response.json() };
}

async function uploaded(sessionId: string, lines: unknown[], as: Request) {
  const response = await upload(sessionId, lines, as);
  expect(response.status, JSON.stringify(response.json)).toBeLessThan(300);
  return response.json;
}

/** Every entry of a Transcript, following its pages. */
async function entriesOf(transcriptId: string, as: Request) {
  const entries = [];
  let after: number | null = null;
  do {
    const page = await ok("GET", `/api/transcripts/${transcriptId}/entries${after === null ? "" : `?after=${after}`}`, as);
    entries.push(...page.entries);
    after = page.next;
  } while (after !== null);
  return entries;
}

/** Lines of a Claude Code JSONL transcript, as Claude Code writes them. */
const at = (second: number) => `2026-01-01T09:00:${String(second).padStart(2, "0")}.000Z`;
const userSays = (text: string, second = 0) => ({
  type: "user",
  sessionId: "local-id",
  uuid: `u-${second}`,
  timestamp: at(second),
  message: { role: "user", content: text },
});
const assistantSays = (text: string, second = 0) => ({
  type: "assistant",
  sessionId: "local-id",
  uuid: `a-${second}`,
  timestamp: at(second),
  message: { id: `msg-${second}`, role: "assistant", model: "claude", content: [{ type: "text", text }] },
});
const toolCall = (id: string, name: string, input: unknown, second = 0) => ({
  type: "assistant",
  uuid: `t-${id}`,
  timestamp: at(second),
  message: { id: `msg-${second}`, role: "assistant", content: [{ type: "tool_use", id, name, input }] },
});
const toolResult = (id: string, content: unknown, second = 0) => ({
  type: "user",
  uuid: `r-${id}`,
  timestamp: at(second),
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
});

/** Ada with her Agent `claude-max` on her fake Runner, with a Write token. */
async function adaWithAgent() {
  const { workspace } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Make it so" });
  const runner = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, ada, { runnerId: runner.id });
  const { token, secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "Transcript hook", access: "write" });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id as string;
  return { workspace, ada, project, ticket, agent, token, asAgent: { headers: { authorization: `Bearer ${secret}` } }, status };
}

describe("uploading a transcript", () => {
  test("an Agent's upload is converted into entries readable through the API", async () => {
    const { ada, agent, asAgent, workspace } = await adaWithAgent();

    const transcript = await uploaded(
      "session_01ABC",
      [
        { type: "summary", summary: "Making it so", leafUuid: "x" },
        userSays("Make it so.", 1),
        assistantSays("Reading the Ticket first.", 2),
        toolCall("toolu_1", "Read", { file_path: "/repo/README.md" }, 3),
        toolResult("toolu_1", "# Cronker\n", 4),
        toolCall("toolu_2", "Bash", { command: "npm test" }, 5),
        toolResult("toolu_2", [{ type: "text", text: "1 passed" }], 6),
        assistantSays("Done.", 7),
      ],
      asAgent,
    );

    expect(transcript).toEqual({
      id: expect.any(String),
      workspaceId: workspace.id,
      slug: `claude-max-${transcript.id.slice(0, 8)}`,
      // claude.ai's `session_…` names its `cse_…` session.
      sessionId: "cse_01ABC",
      agent: { id: agent.id, name: "claude-max" },
      runId: null,
      tickets: [],
      entryCount: 5,
      gap: null,
      uploadedAt: "2026-01-01T09:00:00.000Z",
      redactions: [],
    });
    expect(await ok("GET", `/api/transcripts/${transcript.id}`, ada)).toEqual(transcript);
    const none = { text: null, toolName: null, toolInput: null, toolResult: null, cut: false, cutParts: [] };
    expect(await entriesOf(transcript.id, ada)).toEqual([
      { ...none, position: 1, role: "user", text: "Make it so.", at: at(1) },
      { ...none, position: 2, role: "assistant", text: "Reading the Ticket first.", at: at(2) },
      {
        ...none,
        position: 3,
        role: "assistant",
        toolName: "Read",
        toolInput: { file_path: "/repo/README.md" },
        toolResult: "# Cronker\n",
        at: at(3),
      },
      { ...none, position: 4, role: "assistant", toolName: "Bash", toolInput: { command: "npm test" }, toolResult: "1 passed", at: at(5) },
      { ...none, position: 5, role: "assistant", text: "Done.", at: at(7) },
    ]);
  });
});

/** The body of a made-up GitHub token: 36 letters and digits. */
const github = "16C7e42F292c6912E7710c838347Ae178B4a";

describe("scrubbing secrets", () => {
  test("every known secret pattern becomes [scrubbed] in text, tool input and tool result before it is stored", async () => {
    const { ada, asAgent } = await adaWithAgent();
    // Made-up secrets of the shapes each issuer uses, put together here so the source holds none whole.
    const secrets = {
      cronk: "cronk_agent_" + "Q2xhdWRlIHdhcyBoZXJlIGFuZCBpdCB3YXMgZ29vZCBmdW4h",
      oauth: "cronk_oauth_refresh_" + "aGVsbG8tdGhlcmUtdGhpcy1pcy1hLXJlZnJlc2gtdG9rZW4",
      ghp: "ghp_" + github,
      gho: "gho_" + github,
      ghs: "ghs_" + github,
      githubPat: "github_pat_" + "11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUV",
      anthropic: "sk-ant-" + "api03-abcdefghijklmnopqrstuvwxyz0123456789-ABCDEFGHIJ_klmnop",
      aws: "AKIA" + "IOSFODNN7EXAMPLE",
      slack: "xoxb-" + "123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx",
    };
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEpAIBAAKCAQEA1c7+9z5Pad7OejecsQ0bu3aumQhB6E0mR6p9PbvL0n3zFvXQ",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const said = Object.values(secrets).map((secret) => `token ${secret} here`).join("\n");

    const transcript = await uploaded(
      "session_secrets",
      [
        assistantSays(`${said}\nauthorization: Bearer abc.def-ghi_jkl123\nThe key:\n${pem}\nThat's all.`, 1),
        toolCall("toolu_1", "Bash", { command: `curl -H 'Authorization: bearer ${secrets.ghp}' x`, env: [secrets.aws] }, 2),
        toolResult("toolu_1", `${said}\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA`, 3),
      ],
      asAgent,
    );

    const scrubbed = Object.values(secrets).map(() => "token [scrubbed] here").join("\n");
    const [message, call] = await entriesOf(transcript.id, ada);
    expect(message.text).toBe(
      `${scrubbed}\nauthorization: Bearer [scrubbed]\nThe key:\n[scrubbed]\nThat's all.`,
    );
    expect(call.toolInput).toEqual({ command: "curl -H 'Authorization: bearer [scrubbed]' x", env: ["[scrubbed]"] });
    // A private key whose end was never printed is scrubbed to the end of what was.
    expect(call.toolResult).toBe(`${scrubbed}\n[scrubbed]`);
  });

  test("text that only looks a little like a secret is kept", async () => {
    const { ada, asAgent } = await adaWithAgent();
    const text = "Use a bearer token, see ghp_ docs, sk-ant- prefix, cronk_agent_ tokens and AKIA keys.";

    const transcript = await uploaded("session_plain", [assistantSays(text, 1)], asAgent);

    expect((await entriesOf(transcript.id, ada))[0].text).toBe(text);
  });
});

describe("the caps", () => {
  test("a tool result over 20 KB is cut to its first 20 KB and marked as cut", async () => {
    const { ada, asAgent } = await adaWithAgent();
    const kept = "a".repeat(20 * 1024);

    const transcript = await uploaded(
      "session_long_result",
      [
        toolCall("toolu_1", "Read", { file_path: "big.txt" }, 1),
        toolResult("toolu_1", `${kept}and the rest`, 2),
        toolCall("toolu_2", "Read", { file_path: "exact.txt" }, 3),
        toolResult("toolu_2", kept, 4),
      ],
      asAgent,
    );

    const [long, exact] = await entriesOf(transcript.id, ada);
    expect(long).toMatchObject({ toolResult: kept, cut: true });
    expect(exact).toMatchObject({ toolResult: kept, cut: false });
  });

  test("a cut never splits a character, and a secret is scrubbed before the cut", async () => {
    const { ada, asAgent } = await adaWithAgent();
    // 20 KB less one byte of ASCII, then a two-byte character straddling the cut.
    const ascii = "a".repeat(20 * 1024 - 1);
    const secret = "ghp_" + github;

    const transcript = await uploaded(
      "session_cut",
      [
        toolCall("toolu_1", "Read", {}, 1),
        toolResult("toolu_1", `${ascii}é and more`, 2),
        toolCall("toolu_2", "Read", {}, 3),
        toolResult("toolu_2", `${"b".repeat(20 * 1024 - 10)}${secret}`, 4),
      ],
      asAgent,
    );

    const [split, secretAtCut] = await entriesOf(transcript.id, ada);
    expect(split).toMatchObject({ toolResult: ascii, cut: true });
    expect(secretAtCut).toMatchObject({ toolResult: `${"b".repeat(20 * 1024 - 10)}[scrubbed]`, cut: false });
  });

  test("a tool input over 20 KB as JSON is cut to its JSON's first 20 KB, never splitting a character, and says which part was cut", async () => {
    const { ada, asAgent } = await adaWithAgent();
    // `{"content":"` then ASCII up to 20 KB less one byte, then a two-byte character straddling the cut.
    const start = '{"content":"';
    const ascii = "a".repeat(20 * 1024 - start.length - 1);

    const transcript = await uploaded(
      "session_long_input",
      [
        toolCall("toolu_1", "Write", { content: `${ascii}é and more` }, 1),
        toolResult("toolu_1", "Written.", 2),
        toolCall("toolu_2", "Write", { content: "b".repeat(30 * 1024) }, 3),
        toolResult("toolu_2", "c".repeat(30 * 1024), 4),
        toolCall("toolu_3", "Read", { file_path: "big.txt" }, 5),
        toolResult("toolu_3", "d".repeat(30 * 1024), 6),
        toolCall("toolu_4", "Write", { content: "e".repeat(20 * 1024 - start.length - 2) }, 7),
      ],
      asAgent,
    );

    const [split, both, result, exact] = await entriesOf(transcript.id, ada);
    expect(split).toMatchObject({ toolInput: `${start}${ascii}`, toolResult: "Written.", cut: true, cutParts: ["toolInput"] });
    expect(both).toMatchObject({
      toolInput: `${start}${"b".repeat(20 * 1024 - start.length)}`,
      toolResult: "c".repeat(20 * 1024),
      cut: true,
      cutParts: ["toolInput", "toolResult"],
    });
    expect(result).toMatchObject({ toolInput: { file_path: "big.txt" }, cut: true, cutParts: ["toolResult"] });
    // Its JSON, closing quote and brace included, is 20 KB exactly.
    expect(exact).toMatchObject({ toolInput: { content: "e".repeat(20 * 1024 - start.length - 2) }, cut: false, cutParts: [] });
  });

  test("a Transcript over 50 MB keeps its start and its end, with the gap between marked", async () => {
    const { ada, asAgent } = await adaWithAgent();
    // Sixty messages of 1 MB each: the first and last 25 MB are kept, the 10 MB between left out.
    const megabyte = "m".repeat(1024 * 1024);
    const lines = Array.from({ length: 60 }, (_, index) => assistantSays(`${index + 1}`.padEnd(megabyte.length, "m"), index));

    const transcript = await uploaded("session_huge", lines, asAgent);

    expect(transcript).toMatchObject({ entryCount: 50, gap: { after: 25, entries: 10, bytes: 10 * 1024 * 1024 } });
    const entries = await entriesOf(transcript.id, ada);
    expect(entries.map((entry: { position: number }) => entry.position)).toEqual([
      ...Array.from({ length: 25 }, (_, index) => index + 1),
      ...Array.from({ length: 25 }, (_, index) => index + 36),
    ]);
    expect(entries[25].text.startsWith("36m")).toBe(true);
  }, 60_000);

  test("a Transcript over 50 MB whose last message alone is over 25 MB keeps that message as its end, cut to 20 KB", async () => {
    const { ada, asAgent } = await adaWithAgent();
    const megabyte = 1024 * 1024;
    // Sixty messages of 1 MB, then one of 30 MB, cut to 20 KB: the first 25 messages are the start, and the cut one
    // with the 24 before it the end.
    const lines = [
      ...Array.from({ length: 60 }, (_, index) => assistantSays(`${index + 1}`.padEnd(megabyte, "m"), index)),
      assistantSays(`last${"l".repeat(30 * megabyte)}`, 60),
    ];

    const transcript = await uploaded("session_huge_last", lines, asAgent);

    expect(transcript).toMatchObject({ entryCount: 50, gap: { after: 25, entries: 11, bytes: 11 * megabyte } });
    const entries = await entriesOf(transcript.id, ada);
    expect(entries[25]).toMatchObject({ position: 37, cut: false });
    expect(entries.at(-1)).toMatchObject({ position: 61, text: `last${"l".repeat(20 * 1024 - 4)}`, cut: true, cutParts: ["text"] });
  }, 60_000);

  test("a Transcript over 50 MB whose last entry is a tool call with an input over 25 MB keeps that call as its end, its input cut to 20 KB", async () => {
    const { ada, asAgent } = await adaWithAgent();
    const megabyte = 1024 * 1024;
    // Sixty messages of 1 MB, then a Write of a 30 MB file, its input cut to the first 20 KB of its JSON: the first 25
    // messages are the start, and the call with the 24 messages before it the end.
    const lines = [
      ...Array.from({ length: 60 }, (_, index) => assistantSays(`${index + 1}`.padEnd(megabyte, "m"), index)),
      toolCall("toolu_last", "Write", { file_path: "big.txt", content: "w".repeat(30 * megabyte) }, 60),
    ];

    const transcript = await uploaded("session_huge_input", lines, asAgent);

    expect(transcript).toMatchObject({ entryCount: 50, gap: { after: 25, entries: 11, bytes: 11 * megabyte } });
    const entries = await entriesOf(transcript.id, ada);
    expect(entries[25]).toMatchObject({ position: 37, cut: false, cutParts: [] });
    const start = '{"file_path":"big.txt","content":"';
    expect(entries.at(-1)).toMatchObject({
      position: 61,
      toolName: "Write",
      toolInput: `${start}${"w".repeat(20 * 1024 - start.length)}`,
      cut: true,
      cutParts: ["toolInput"],
    });
  }, 60_000);

  test("a Transcript over 50 MB only by its last message keeps everything else whole once that message is cut", async () => {
    const { ada, asAgent } = await adaWithAgent();
    const lines = [assistantSays("m".repeat(30 * 1024 * 1024), 1), assistantSays("l".repeat(30 * 1024 * 1024), 2)];

    const transcript = await uploaded("session_cut_last", lines, asAgent);

    expect(transcript).toMatchObject({ entryCount: 2, gap: null });
    const [first, last] = await entriesOf(transcript.id, ada);
    expect(first).toMatchObject({ cut: false });
    expect(first.text).toHaveLength(30 * 1024 * 1024);
    expect(last).toMatchObject({ text: "l".repeat(20 * 1024), cut: true });
  }, 60_000);

  test("a Transcript of 50 MB exactly is kept whole", async () => {
    const { asAgent } = await adaWithAgent();
    const lines = Array.from({ length: 50 }, (_, index) => assistantSays("m".repeat(1024 * 1024), index));

    const transcript = await uploaded("session_whole", lines, asAgent);

    expect(transcript).toMatchObject({ entryCount: 50, gap: null });
  }, 60_000);
});

describe("uploading the same session again", () => {
  test("replaces what Cronk held for the session, never duplicating entries", async () => {
    const { ada, asAgent } = await adaWithAgent();
    const first = await upload("session_again", [userSays("Make it so.", 1), assistantSays("On it.", 2)], asAgent);
    expect(first.status).toBe(201);

    cronk.clock.advance(60_000);
    const second = await upload(
      "session_again",
      [userSays("Make it so.", 1), assistantSays("On it.", 2), assistantSays("Done.", 3)],
      asAgent,
    );

    expect(second.status).toBe(200);
    expect(second.json).toMatchObject({ id: first.json.id, entryCount: 3, uploadedAt: "2026-01-01T09:01:00.000Z" });
    expect((await entriesOf(first.json.id, ada)).map((entry: { text: string }) => entry.text)).toEqual([
      "Make it so.",
      "On it.",
      "Done.",
    ]);
  });

  test("a smaller upload after a cut one leaves no gap behind", async () => {
    const { asAgent } = await adaWithAgent();
    const huge = Array.from({ length: 51 }, (_, index) => assistantSays("m".repeat(1024 * 1024), index));
    expect((await uploaded("session_shrinks", huge, asAgent)).gap).not.toBeNull();

    const again = await uploaded("session_shrinks", [assistantSays("Started over.", 1)], asAgent);

    expect(again).toMatchObject({ entryCount: 1, gap: null });
  }, 60_000);
});

describe("who may upload", () => {
  test("a revoked token, a wrong token, a read-only token and a User are refused, and nothing is stored", async () => {
    const { ada, agent, token, asAgent } = await adaWithAgent();
    const { secret: readOnly } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "read", access: "read" });
    const lines = [userSays("Make it so.", 1)];

    expect((await upload("session_x", lines, { headers: { authorization: "Bearer cronk_agent_wrong" } })).json.error.code).toBe(
      "invalid_token",
    );
    expect((await upload("session_x", lines, { headers: { authorization: `Bearer ${readOnly}` } })).json.error.code).toBe(
      "read_only_token",
    );
    const asUser = await fetch(`${cronk.url}/api/transcripts/sessions/session_x`, {
      method: "PUT",
      headers: { "content-type": "application/x-ndjson", cookie: ada.cookie, origin: cronk.url },
      body: JSON.stringify(lines[0]),
    });
    expect(asUser.status).toBe(401);
    await ok("DELETE", `/api/agents/${agent.id}/tokens/${token.id}`, ada);
    const revoked = await upload("session_x", lines, asAgent);
    expect(revoked.status).toBe(401);
    expect(revoked.json.error.code).toBe("invalid_token");
  });

  test("an Agent of another Workspace can't read a Transcript", async () => {
    const { asAgent } = await adaWithAgent();
    const transcript = await uploaded("session_mine", [userSays("Make it so.", 1)], asAgent);
    const ada = { cookie: await signIn(cronk) };
    const other = await ok("POST", "/api/workspaces", ada, { name: "Elsewhere" });
    const stranger = await ok("POST", `/api/workspaces/${other.id}/agents`, ada, { name: "stranger" });
    const { secret } = await ok("POST", `/api/agents/${stranger.id}/tokens`, ada, { name: "t", access: "read" });
    const asStranger = { headers: { authorization: `Bearer ${secret}` } };

    expect((await call("GET", `/api/transcripts/${transcript.id}`, asStranger)).status).toBe(404);
    expect((await call("GET", `/api/transcripts/${transcript.id}/entries`, asStranger)).status).toBe(404);
  });
});

describe("a Run's Transcript", () => {
  test("an upload whose session is the one the Run's Runner returned at start is that Run's Transcript", async () => {
    const { ada, ticket, agent, asAgent, status } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Triage") });
    const [run] = await ok("GET", `/api/tickets/${ticket.id}/runs`, ada);
    expect(run).toMatchObject({ sessionUrl: "https://claude.ai/code/cse_1", transcriptId: null, transcriptSlug: null });

    // claude.ai started it as `cse_1`; the Transcript hook names the same session `session_1`.
    const transcript = await uploaded(
      "session_1",
      [userSays("Triage CRONK-1.", 1), toolCall("t1", "mcp__cronk__read_ticket", { ticket: "CRONK-1" }, 2)],
      asAgent,
    );

    expect(transcript.runId).toBe(run.id);
    // It shows on the Ticket with its Run, not a second time as a Transcript naming the Ticket.
    expect(transcript.tickets).toEqual([]);
    expect(await ok("GET", `/api/tickets/${ticket.id}/transcripts`, ada)).toEqual([]);
    expect(await ok("GET", `/api/runs/${run.id}`, ada)).toMatchObject({
      sessionUrl: "https://claude.ai/code/cse_1",
      transcriptId: transcript.id,
      transcriptSlug: `claude-max-${transcript.id.slice(0, 8)}`,
    });
    expect(await ok("GET", `/api/tickets/${ticket.id}/runs`, ada)).toMatchObject([{ transcriptId: transcript.id }]);
    // The board's card carries it too, for its menu's Open Transcript.
    const [card] = await ok("GET", `/api/projects/${ticket.projectId}/tickets`, ada);
    expect(card.lastRun).toMatchObject({ id: run.id, transcriptSlug: `claude-max-${transcript.id.slice(0, 8)}` });
  });

  test("the session of another Agent's Run is not that Run's Transcript", async () => {
    const { ada, workspace, ticket, agent, status } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Triage") });
    const other = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "laptop" });
    const { secret } = await ok("POST", `/api/agents/${other.id}/tokens`, ada, { name: "t", access: "write" });

    const transcript = await uploaded("session_1", [userSays("Hello.", 1)], { headers: { authorization: `Bearer ${secret}` } });

    expect(transcript.runId).toBeNull();
    expect(await ok("GET", `/api/tickets/${ticket.id}/runs`, ada)).toMatchObject([{ transcriptId: null }]);
  });

  test("an upload naming the session as claude.ai started it, `cse_…`, is that Run's Transcript too", async () => {
    const { ada, ticket, agent, asAgent, status } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Triage") });
    const [run] = await ok("GET", `/api/tickets/${ticket.id}/runs`, ada);

    const first = await uploaded("cse_1", [userSays("Triage CRONK-1.", 1)], asAgent);
    const again = await upload("session_1", [userSays("Triage CRONK-1.", 1), assistantSays("Reading it.", 2)], asAgent);

    expect(first).toMatchObject({ sessionId: "cse_1", runId: run.id });
    // Both names are one session, so the second upload replaces the first.
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ id: first.id, sessionId: "cse_1", runId: run.id, entryCount: 2 });
  });

  test("an upgrade gives each Run the Transcript an earlier Cronk kept as a session of no Run", async () => {
    await cronk.stop();
    cronk = await startCronk({ migrateBefore: "0064_claude_session_ids.sql" });
    // Reading a Ticket needs the conflict that last set its Merge Queue entry aside, and its Term Mentions.
    await cronk.applyAhead("0065_merge_queue_conflicts.sql");
    await cronk.applyAhead("0068_decision_mentions.sql");
    await cronk.applyAhead("0070_term_mentions.sql");
    // Writing a Ticket clears its undelegated mark.
    await cronk.applyAhead("0073_agent_access_undelegated.sql");
    // Reading a Ticket needs its Release.
    await cronk.applyAhead("0075_releases.sql");
    // And its Backport.
    await cronk.applyAhead("0078_backports.sql");
    // And a Write token.
    await cronk.applyAhead("0079_token_levels.sql");
    // And its Runs' costs, estimates apart.
    await cronk.applyAhead("0084_cost_estimates.sql");
    // And a Runner's allowlist.
    await cronk.applyAhead("0085_runner_allowlists.sql");
    const { workspace, ada, ticket, agent, status } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Triage") });
    const [run] = await ok("GET", `/api/tickets/${ticket.id}/runs`, ada);
    // claude.ai started the Run as `cse_1`, and the hook's uploads, as `session_1`, matched none of its Runs: each
    // became a Transcript of no Run, linked to the Ticket its calls named.
    const transcriptId = crypto.randomUUID();
    await cronk.stage(
      "insert into transcripts (id, workspace_id, agent_id, session_id, uploaded_at) values ($1, $2, $3, 'session_1', now())",
      [transcriptId, workspace.id, agent.id],
    );
    await cronk.stage(
      "insert into transcript_tickets (transcript_id, ticket_id, workspace_id, named_at, position) values ($1, $2, $3, now(), 1)",
      [transcriptId, ticket.id, workspace.id],
    );

    await cronk.upgrade();

    expect(await ok("GET", `/api/runs/${run.id}`, ada)).toMatchObject({ transcriptId });
    expect(await ok("GET", `/api/transcripts/${transcriptId}`, ada)).toMatchObject({ sessionId: "cse_1", runId: run.id, tickets: [] });
    expect(await ok("GET", `/api/tickets/${ticket.id}/transcripts`, ada)).toEqual([]);
  });
});

describe("hand-connected Claude Code", () => {
  test("an upload whose session matches no Run is kept as the Agent's own Transcript, listed on the Agent", async () => {
    const { ada, ticket, agent, asAgent, status } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Triage") });
    const ofRun = await uploaded("session_1", [userSays("Triage CRONK-1.", 1)], asAgent);

    const first = await uploaded("laptop-1", [userSays("What's on CRONK-1?", 1)], asAgent);
    cronk.clock.advance(60_000);
    const second = await uploaded("laptop-2", [userSays("Hello.", 1), assistantSays("Hi.", 2)], asAgent);

    expect(ofRun.runId).not.toBeNull();
    expect(first).toMatchObject({ sessionId: "laptop-1", runId: null });
    // Newest upload first; a Run's Transcript is listed with its Run, not here.
    expect(await ok("GET", `/api/agents/${agent.id}/transcripts`, ada)).toEqual([second, first]);
  });

  test("is linked to each Ticket its Cronk tool calls name, and listed on those Tickets", async () => {
    const { ada, project, ticket, asAgent } = await adaWithAgent();
    const second = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Second" });
    const third = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Third" });
    const untouched = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Only mentioned" });

    const transcript = await uploaded(
      "laptop-1",
      [
        userSays("Look at CRONK-4 and CRONK-1.", 1),
        toolCall("t1", "mcp__cronk__read_ticket", { ticket: "cronk-1" }, 2),
        toolResult("t1", "{}", 3),
        // A Ticket named by its id, and the Ticket a block names.
        toolCall("t2", "mcp__cronk__add_block", { ticket: third.id, blocks: "CRONK-2" }, 4),
        toolCall("t3", "mcp__cronk__comment", { ticket: "CRONK-1", body: "Also CRONK-4." }, 5),
        // Neither another server's tools, nor a key of no Ticket, link anything.
        toolCall("t4", "mcp__linear__read_issue", { ticket: "CRONK-4" }, 6),
        toolCall("t5", "mcp__cronk__read_ticket", { ticket: "CRONK-99" }, 7),
        assistantSays("CRONK-4 is fine.", 8),
      ],
      asAgent,
    );

    const ref = (t: { id: string; key: string; title: string }) => ({ id: t.id, key: t.key, title: t.title });
    // In the order the calls first named them.
    expect(transcript.tickets).toEqual([ref(ticket), ref(third), ref(second)]);
    expect(await ok("GET", `/api/transcripts/${transcript.id}`, ada)).toEqual(transcript);
    expect(await ok("GET", `/api/tickets/${ticket.id}/transcripts`, ada)).toEqual([{ ...transcript, namedAt: at(2) }]);
    expect(await ok("GET", `/api/tickets/${third.id}/transcripts`, ada)).toEqual([{ ...transcript, namedAt: at(4) }]);
    expect(await ok("GET", `/api/tickets/${second.id}/transcripts`, ada)).toEqual([{ ...transcript, namedAt: at(4) }]);
    expect(await ok("GET", `/api/tickets/${untouched.id}/transcripts`, ada)).toEqual([]);
  });

  test("uploading it again with more turns updates its Ticket links", async () => {
    const { ada, project, ticket, agent, asAgent } = await adaWithAgent();
    const second = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Second" });
    const firstTurn = [userSays("Look at CRONK-1.", 1), toolCall("t1", "mcp__cronk__read_ticket", { ticket: "CRONK-1" }, 2)];
    const before = await uploaded("laptop-1", firstTurn, asAgent);
    expect(await ok("GET", `/api/tickets/${second.id}/transcripts`, ada)).toEqual([]);

    const after = await uploaded(
      "laptop-1",
      [
        ...firstTurn,
        toolResult("t1", "{}", 3),
        userSays("Now CRONK-2.", 4),
        toolCall("t2", "mcp__cronk__edit_ticket", { ticket: "CRONK-2", priority: "high" }, 5),
      ],
      asAgent,
    );

    const ref = (t: { id: string; key: string; title: string }) => ({ id: t.id, key: t.key, title: t.title });
    expect(after).toMatchObject({ id: before.id, tickets: [ref(ticket), ref(second)] });
    expect(await ok("GET", `/api/tickets/${ticket.id}/transcripts`, ada)).toEqual([{ ...after, namedAt: at(2) }]);
    expect(await ok("GET", `/api/tickets/${second.id}/transcripts`, ada)).toEqual([{ ...after, namedAt: at(5) }]);
    expect(await ok("GET", `/api/agents/${agent.id}/transcripts`, ada)).toEqual([after]);

    // An upload that no longer names a Ticket, as after Claude Code's history was rewritten, unlinks it.
    const rewritten = await uploaded("laptop-1", [userSays("Start over.", 1)], asAgent);
    expect(rewritten.tickets).toEqual([]);
    expect(await ok("GET", `/api/tickets/${ticket.id}/transcripts`, ada)).toEqual([]);
  });

  test("a call the transcript gives no time keeps its place in the timeline when uploaded again", async () => {
    const { ada, ticket, asAgent } = await adaWithAgent();
    const { timestamp: _, ...untimed } = toolCall("t1", "mcp__cronk__read_ticket", { ticket: "CRONK-1" });
    await uploaded("laptop-1", [untimed], asAgent);
    const [first] = await ok("GET", `/api/tickets/${ticket.id}/transcripts`, ada);
    expect(first.namedAt).toBe(first.uploadedAt);

    cronk.clock.advance(60_000);
    await uploaded("laptop-1", [untimed, userSays("And now?", 1)], asAgent);

    expect(await ok("GET", `/api/tickets/${ticket.id}/transcripts`, ada)).toMatchObject([{ namedAt: first.namedAt }]);
  });

  test("an open Ticket hears of a Transcript linked to it or unlinked from it", async () => {
    const { ada, workspace, project, ticket, asAgent } = await adaWithAgent();
    const second = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Second" });
    const stream = await openStream(cronk, ada.cookie!, workspace.id);
    const changed = (ticketId: string) => ({ type: "transcripts.changed", data: { projectId: project.id, ticketId } });

    // Each upload also tells an open Transcript page of itself.
    const uploadedAgain = (transcriptId: string) => ({ type: "transcript.changed", data: { transcriptId, runId: null } });

    const { id } = await uploaded("laptop-1", [toolCall("t1", "mcp__cronk__read_ticket", { ticket: "CRONK-1" }, 1)], asAgent);
    expect([await stream.next(), await stream.next()]).toEqual([changed(ticket.id), uploadedAgain(id)]);
    await uploaded("laptop-1", [toolCall("t1", "mcp__cronk__read_ticket", { ticket: "CRONK-2" }, 1)], asAgent);
    expect([await stream.next(), await stream.next(), await stream.next()]).toEqual(
      expect.arrayContaining([changed(ticket.id), changed(second.id), uploadedAgain(id)]),
    );
    stream.close();
  });

  test("an Agent of another Workspace can't list an Agent's Transcripts", async () => {
    const { agent, asAgent } = await adaWithAgent();
    await uploaded("laptop-1", [userSays("Hello.", 1)], asAgent);
    const ada = { cookie: await signIn(cronk) };
    const other = await ok("POST", "/api/workspaces", ada, { name: "Elsewhere" });
    const stranger = await ok("POST", `/api/workspaces/${other.id}/agents`, ada, { name: "stranger" });
    const { secret } = await ok("POST", `/api/agents/${stranger.id}/tokens`, ada, { name: "t", access: "read" });

    const listed = await call("GET", `/api/agents/${agent.id}/transcripts`, { headers: { authorization: `Bearer ${secret}` } });

    expect(listed.status).toBe(404);
  });
});

describe("deleting a Transcript", () => {
  test("a User deletes a Run's Transcript: its entries are gone and its Run says it was deleted", async () => {
    const { ada, ticket, agent, asAgent, status } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Triage") });
    const transcript = await uploaded("session_1", [userSays("Triage CRONK-1.", 1), assistantSays("ghp_missed", 2)], asAgent);

    expect((await call("DELETE", `/api/transcripts/${transcript.id}`, ada)).status).toBe(204);

    expect((await call("GET", `/api/transcripts/${transcript.id}`, ada)).status).toBe(404);
    expect((await call("GET", `/api/transcripts/${transcript.id}/entries`, ada)).status).toBe(404);
    const [run] = await ok("GET", `/api/tickets/${ticket.id}/runs`, ada);
    expect(run).toMatchObject({ transcriptId: null, transcriptDeleted: true });
  });

  test("a Write token's delete is refused, its own Transcript included, and the Transcript is kept", async () => {
    const { ada, asAgent } = await adaWithAgent();
    const transcript = await uploaded("laptop-session", [userSays("Hello.", 1)], asAgent);

    const refused = await call("DELETE", `/api/transcripts/${transcript.id}`, asAgent);

    expect(refused).toMatchObject({ status: 403, json: { error: { code: "full_token_needed" } } });
    expect(await entriesOf(transcript.id, ada)).toMatchObject([{ text: "Hello." }]);
  });

  test("a later upload of a deleted Transcript's session is refused, so the hook's next turn can't bring it back", async () => {
    const { ada, ticket, agent, asAgent, status } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Triage") });
    const transcript = await uploaded("session_1", [userSays("ghp_missed", 1)], asAgent);
    await ok("DELETE", `/api/transcripts/${transcript.id}`, ada);

    const again = await upload("session_1", [userSays("ghp_missed", 1), assistantSays("Next turn.", 2)], asAgent);

    expect(again).toMatchObject({ status: 410, json: { error: { code: "transcript_deleted" } } });
    expect((await call("GET", `/api/transcripts/${transcript.id}`, ada)).status).toBe(404);
    expect(await ok("GET", `/api/tickets/${ticket.id}/runs`, ada)).toMatchObject([{ transcriptId: null, transcriptDeleted: true }]);
  });

  test("deleting a Run's Transcript is recorded on its Ticket's timeline, naming the Run, and tells the Workspace's streams", async () => {
    const { workspace, ada, project, ticket, agent, asAgent, status } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Triage") });
    const [run] = await ok("GET", `/api/tickets/${ticket.id}/runs`, ada);
    const transcript = await uploaded("session_1", [userSays("Triage CRONK-1.", 1)], asAgent);
    const stream = await openStream(cronk, ada.cookie, workspace.id);

    await ok("DELETE", `/api/transcripts/${transcript.id}`, ada);

    expect([await stream.next(), await stream.next()]).toEqual(
      expect.arrayContaining([
        { type: "ticket.changed", data: { projectId: project.id, ticketId: ticket.id } },
        { type: "transcript.changed", data: { transcriptId: transcript.id, runId: run.id } },
      ]),
    );
    const [deleted] = (await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada)).slice(-1);
    expect(deleted).toEqual(
      expect.objectContaining({
        field: "transcriptDeleted",
        from: { runId: run.id, step: "Triage", sessionId: "cse_1", agent: { id: agent.id, name: "claude-max" } },
        to: null,
        actor: expect.objectContaining({ kind: "user", name: "ada@example.com" }),
        runId: null,
      }),
    );
  });
});

describe("deleting a Transcript of a session outside a Run", () => {
  test("drops it from its Agent and the Tickets it named, recording the deletion on each of them", async () => {
    const { workspace, ada, project, ticket, agent, asAgent } = await adaWithAgent();
    const second = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Second" });
    const transcript = await uploaded(
      "laptop-1",
      [
        toolCall("t1", "mcp__cronk__read_ticket", { ticket: "CRONK-1" }, 1),
        toolCall("t2", "mcp__cronk__read_ticket", { ticket: "CRONK-2" }, 2),
      ],
      asAgent,
    );
    const stream = await openStream(cronk, ada.cookie, workspace.id);

    await ok("DELETE", `/api/transcripts/${transcript.id}`, ada);

    expect(await ok("GET", `/api/agents/${agent.id}/transcripts`, ada)).toEqual([]);
    expect(await ok("GET", `/api/tickets/${ticket.id}/transcripts`, ada)).toEqual([]);
    expect(await ok("GET", `/api/tickets/${second.id}/transcripts`, ada)).toEqual([]);
    for (const named of [ticket, second]) {
      const [deleted] = (await ok("GET", `/api/tickets/${named.id}/timeline`, ada)).slice(-1);
      expect(deleted).toEqual(
        expect.objectContaining({
          field: "transcriptDeleted",
          from: { runId: null, step: null, sessionId: "laptop-1", agent: { id: agent.id, name: "claude-max" } },
          to: null,
          actor: expect.objectContaining({ kind: "user", name: "ada@example.com" }),
        }),
      );
    }
    const changed = (ticketId: string) => ({ type: "transcripts.changed", data: { projectId: project.id, ticketId } });
    expect([await stream.next(), await stream.next(), await stream.next()]).toEqual(
      expect.arrayContaining([
        changed(ticket.id),
        changed(second.id),
        { type: "transcript.changed", data: { transcriptId: transcript.id, runId: null } },
      ]),
    );
  });
});

describe("redacting part of a Transcript", () => {
  /** A secret the scrubbing doesn't know the shape of. */
  const secret = "zorblaxquux42";

  test("every appearance in messages, tool inputs and tool results becomes [redacted], and search no longer finds it", async () => {
    const { workspace, ada, asAgent } = await adaWithAgent();
    const transcript = await uploaded(
      "laptop-session",
      [
        userSays(`The vault code is ${secret}, twice: ${secret}.`, 1),
        toolCall("t1", "Bash", { command: `unlock --code ${secret}`, [secret]: ["x", secret] }, 2),
        toolResult("t1", `unlocked with ${secret}`, 3),
        assistantSays("Nothing secret here.", 4),
      ],
      asAgent,
    );
    const search = () => ok("GET", `/api/workspaces/${workspace.id}/search?q=${secret}`, ada);
    expect(await search()).toEqual([expect.objectContaining({ kind: "transcript", id: transcript.id })]);

    const after = await call("POST", `/api/transcripts/${transcript.id}/redactions`, ada, { text: secret });

    expect(after.status).toBe(201);
    expect(after.json.redactions).toEqual([
      { id: expect.any(String), addedBy: { id: expect.any(String), name: "ada@example.com" }, addedAt: expect.any(String) },
    ]);
    expect(await entriesOf(transcript.id, ada)).toMatchObject([
      { text: "The vault code is [redacted], twice: [redacted]." },
      { toolInput: { command: "unlock --code [redacted]", "[redacted]": ["x", "[redacted]"] }, toolResult: "unlocked with [redacted]" },
      { text: "Nothing secret here." },
    ]);
    expect(await search()).toEqual([]);
  });

  test("the string is never returned, only who added each Redaction and when", async () => {
    const { ada, asAgent } = await adaWithAgent();
    const transcript = await uploaded("laptop-session", [userSays(`code ${secret}`, 1)], asAgent);

    const redacted = await ok("POST", `/api/transcripts/${transcript.id}/redactions`, ada, { text: secret });
    const read = await ok("GET", `/api/transcripts/${transcript.id}`, ada);

    expect(JSON.stringify(redacted)).not.toContain(secret);
    expect(JSON.stringify(read)).not.toContain(secret);
    expect(read.redactions).toHaveLength(1);
  });

  test("a string shorter than 4 characters is refused, and the Transcript is kept as it was", async () => {
    const { ada, asAgent } = await adaWithAgent();
    const transcript = await uploaded("laptop-session", [userSays("abc def", 1)], asAgent);

    const refused = await call("POST", `/api/transcripts/${transcript.id}/redactions`, ada, { text: "abc" });

    expect(refused).toMatchObject({
      status: 400,
      json: { error: { code: "redaction_too_short", rule: expect.any(String), advice: expect.any(String) } },
    });
    expect(await entriesOf(transcript.id, ada)).toMatchObject([{ text: "abc def" }]);
    expect((await ok("GET", `/api/transcripts/${transcript.id}`, ada)).redactions).toEqual([]);
  });

  test("a Write token is refused, its own Transcript included, with a rule and advice", async () => {
    const { ada, asAgent } = await adaWithAgent();
    const transcript = await uploaded("laptop-session", [userSays(`code ${secret}`, 1)], asAgent);

    const refused = await call("POST", `/api/transcripts/${transcript.id}/redactions`, asAgent, { text: secret });

    expect(refused).toMatchObject({
      status: 403,
      json: { error: { code: "full_token_needed", rule: expect.any(String), advice: expect.any(String) } },
    });
    expect(await entriesOf(transcript.id, ada)).toMatchObject([{ text: `code ${secret}` }]);
  });

  test("a User who can't read the Transcript can't redact it", async () => {
    const { ada, asAgent } = await adaWithAgent();
    const transcript = await uploaded("laptop-session", [userSays(`code ${secret}`, 1)], asAgent);
    await ok("DELETE", `/api/transcripts/${transcript.id}`, ada);

    expect((await call("POST", `/api/transcripts/${transcript.id}/redactions`, ada, { text: secret })).status).toBe(404);
  });

  test("a Redaction can't be removed", async () => {
    const { ada, asAgent } = await adaWithAgent();
    const transcript = await uploaded("laptop-session", [userSays(`code ${secret}`, 1)], asAgent);
    const { redactions } = await ok("POST", `/api/transcripts/${transcript.id}/redactions`, ada, { text: secret });

    const removing = await call("DELETE", `/api/transcripts/${transcript.id}/redactions/${redactions[0].id}`, ada);

    expect(removing.status).toBe(404);
    expect((await ok("GET", `/api/transcripts/${transcript.id}`, ada)).redactions).toHaveLength(1);
  });

  test("redacting the same string again adds no second Redaction", async () => {
    const { ada, asAgent } = await adaWithAgent();
    const transcript = await uploaded("laptop-session", [userSays(`code ${secret}`, 1)], asAgent);
    await ok("POST", `/api/transcripts/${transcript.id}/redactions`, ada, { text: secret });

    const again = await ok("POST", `/api/transcripts/${transcript.id}/redactions`, ada, { text: secret });

    expect(again.redactions).toHaveLength(1);
  });

  test("uploading the session again keeps it redacted, applied after the scrubbing and before the 20 KB cut", async () => {
    const { ada, asAgent } = await adaWithAgent();
    const first = [userSays(`code ${secret}`, 1)];
    const transcript = await uploaded("laptop-session", first, asAgent);
    await ok("POST", `/api/transcripts/${transcript.id}/redactions`, ada, { text: secret });
    // The secret straddles the 20 KB cut of a tool result: redacted whole before the cut.
    const long = "x".repeat(20 * 1024 - 5) + secret;

    await uploaded(
      "laptop-session",
      [...first, assistantSays(`again ${secret} and ghp_${github}`, 2), toolCall("t1", "Bash", { command: "cat" }, 3), toolResult("t1", long, 4)],
      asAgent,
    );

    const entries = await entriesOf(transcript.id, ada);
    expect(entries).toMatchObject([
      { text: "code [redacted]" },
      { text: "again [redacted] and [scrubbed]" },
      { toolName: "Bash", cut: true },
    ]);
    expect(entries[2].toolResult).toMatch(/^x+\[red/);
    expect(JSON.stringify(entries)).not.toContain("zorb");
  });

  test("tells the Transcript's viewers, so an open Transcript page shows it redacted", async () => {
    const { workspace, ada, asAgent } = await adaWithAgent();
    const transcript = await uploaded("laptop-session", [userSays(`code ${secret}`, 1)], asAgent);
    const stream = await openStream(cronk, ada.cookie, workspace.id);

    await ok("POST", `/api/transcripts/${transcript.id}/redactions`, ada, { text: secret });

    expect(await stream.next()).toEqual({ type: "transcript.changed", data: { transcriptId: transcript.id, runId: null } });
  });
});

describe("following a Transcript live", () => {
  test("each upload of a session tells the Workspace's streams, so an open Transcript page shows its new entries", async () => {
    const { workspace, ada, asAgent } = await adaWithAgent();
    const transcript = await uploaded("laptop-session", [userSays("Hello.", 1)], asAgent);
    const stream = await openStream(cronk, ada.cookie, workspace.id);

    await uploaded("laptop-session", [userSays("Hello.", 1), assistantSays("Hi.", 2)], asAgent);

    expect(await stream.next()).toEqual({ type: "transcript.changed", data: { transcriptId: transcript.id, runId: null } });
    expect(await entriesOf(transcript.id, ada)).toMatchObject([{ text: "Hello." }, { text: "Hi." }]);
  });

  test("the first upload of a Run's session also tells the Run's Ticket's viewers, so its timeline links the Transcript", async () => {
    const { workspace, ada, project, ticket, agent, asAgent, status } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Triage") });
    const [run] = await ok("GET", `/api/tickets/${ticket.id}/runs`, ada);
    const stream = await openStream(cronk, ada.cookie, workspace.id);

    const transcript = await uploaded("session_1", [userSays("Triage CRONK-1.", 1)], asAgent);

    expect([await stream.next(), await stream.next()]).toEqual(
      expect.arrayContaining([
        { type: "ticket.changed", data: { projectId: project.id, ticketId: ticket.id } },
        { type: "transcript.changed", data: { transcriptId: transcript.id, runId: run.id } },
      ]),
    );
  });
});
