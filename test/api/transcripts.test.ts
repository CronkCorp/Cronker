import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

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

/** Ada with her Agent `claude-max` on her fake Runner, with a full token. */
async function adaWithAgent() {
  const { workspace } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Make it so" });
  const runner = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, ada, { runnerId: runner.id });
  const { token, secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "Transcript hook", access: "full" });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id as string;
  return { workspace, ada, project, ticket, agent, token, asAgent: { headers: { authorization: `Bearer ${secret}` } }, status };
}

describe("uploading a transcript", () => {
  test("an Agent's upload is converted into entries readable through the API", async () => {
    const { ada, agent, asAgent } = await adaWithAgent();

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
      sessionId: "session_01ABC",
      agent: { id: agent.id, name: "claude-max" },
      runId: null,
      entryCount: 5,
      gap: null,
      uploadedAt: "2026-01-01T09:00:00.000Z",
    });
    expect(await ok("GET", `/api/transcripts/${transcript.id}`, ada)).toEqual(transcript);
    const none = { text: null, toolName: null, toolInput: null, toolResult: null, cut: false };
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

  test("a Transcript of 50 MB exactly is kept whole", async () => {
    const { asAgent } = await adaWithAgent();
    const lines = Array.from({ length: 50 }, (_, index) => assistantSays("m".repeat(1024 * 1024), index));

    const transcript = await uploaded("session_whole", lines, asAgent);

    expect(transcript).toMatchObject({ entryCount: 50, gap: null });
  }, 60_000);
});
