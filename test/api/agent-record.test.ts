import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addMember, setUp, signIn } from "../harness/flows.js";
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

/** Uploads a transcript of one message for the session, as the Transcript hook does. */
async function upload(sessionId: string, as: Request) {
  const line = { type: "user", uuid: "u-1", timestamp: "2026-01-01T09:00:00.000Z", message: { role: "user", content: "Hello." } };
  const response = await fetch(`${cronk.url}/api/transcripts/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PUT",
    headers: { "content-type": "application/x-ndjson", ...as.headers },
    body: JSON.stringify(line) + "\n",
  });
  const json = await response.json();
  expect(response.status, JSON.stringify(json)).toBeLessThan(300);
  return json;
}

const tick = () => cronk.clock.advance(1000);

/**
 * Ada with a Project CRONK on the default board, her Agent `claude-max` on her fake Runner running a Triage Run on
 * CRONK-1, and its full token.
 */
async function runningRun() {
  const { workspace } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Make it so" });
  const runner = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, ada, { runnerId: runner.id });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "cloud", access: "full" });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id as string;
  tick();
  await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });
  const [run] = await ok("GET", `/api/tickets/${ticket.id}/runs`, ada);
  const asAgent = { headers: { authorization: `Bearer ${secret}` } };
  return { workspace, ada, project, ticket, agent, run, asAgent };
}

const page = (html: string) => [{ path: "index.html", contentBase64: Buffer.from(html).toString("base64") }];

/** Every entry of the Record, following its pages. */
async function wholeRecord(agentId: string, as: Request, limit = 2) {
  const entries = [];
  let before: string | null = null;
  do {
    const query: string = `?limit=${limit}${before === null ? "" : `&before=${encodeURIComponent(before)}`}`;
    const record = await ok("GET", `/api/agents/${agentId}/record${query}`, as);
    expect(record.entries.length).toBeLessThanOrEqual(limit);
    entries.push(...record.entries);
    before = record.next;
  } while (before !== null);
  return entries;
}

describe("the Agent Record", () => {
  test("lists the Agent's Comments on a Document, by the Document's current title", async () => {
    const { ada, project, agent, asAgent } = await runningRun();
    const document = await ok("POST", `/api/projects/${project.id}/documents`, ada, { title: "Plan", body: "One." });
    tick();
    const comment = await ok("POST", `/api/documents/${document.id}/comments`, asAgent, { body: "Step two?" });
    await ok("PATCH", `/api/documents/${document.id}`, ada, { baseVersion: 1, title: "The plan" });

    const record = await ok("GET", `/api/agents/${agent.id}/record`, ada);
    expect(record.entries.filter((e: { kind: string }) => e.kind === "comment")).toEqual([
      {
        kind: "comment",
        id: comment.id,
        at: comment.createdAt,
        body: "Step two?",
        replyToId: null,
        ticket: null,
        artifact: null,
        document: { id: document.id, slug: expect.stringMatching(/^the-plan-/), title: "The plan" },
      },
    ]);
  });

  test("lists the Agent's Runs, Changes, Comments, Versions and Transcripts, newest first", async () => {
    const { workspace, ada, project, ticket, agent, run, asAgent } = await runningRun();
    const ticketRef = { id: ticket.id, projectId: project.id, key: "CRONK-1", title: "Make it so" };

    tick();
    await ok("PATCH", `/api/tickets/${ticket.id}`, asAgent, { priority: "high" });
    tick();
    const comment = await ok("POST", `/api/tickets/${ticket.id}/comments`, asAgent, { body: "Looking into it." });
    tick();
    const document = await ok("POST", `/api/projects/${project.id}/documents`, asAgent, { title: "Plan", body: "One." });
    tick();
    const term = await ok("POST", `/api/projects/${project.id}/terms`, asAgent, { name: "Record", definition: "What it did." });
    tick();
    const decision = await ok("POST", `/api/workspaces/${workspace.id}/decisions`, asAgent, { title: "Keep it", body: "Why." });
    tick();
    const artifact = await ok("POST", `/api/projects/${project.id}/artifacts`, asAgent, { title: "Board", files: page("<p>1</p>") });
    tick();
    const artifactComment = await ok("POST", `/api/artifacts/${artifact.id}/comments`, asAgent, { body: "Columns too narrow." });
    tick();
    const transcript = await upload("laptop-1", asAgent);
    // Ada's own doings aren't the Agent's.
    tick();
    await ok("POST", `/api/tickets/${ticket.id}/comments`, ada, { body: "Thanks." });

    const record = await ok("GET", `/api/agents/${agent.id}/record`, ada);

    expect(record.agent).toEqual({
      id: agent.id,
      workspaceId: workspace.id,
      name: "claude-max",
      owner: expect.objectContaining({ email: "ada@example.com" }),
      removedAt: null,
    });
    expect(record.next).toBeNull();
    expect(record.entries).toEqual([
      expect.objectContaining({ kind: "transcript", id: transcript.id, slug: transcript.slug, sessionId: "laptop-1", tickets: [] }),
      {
        kind: "comment",
        id: artifactComment.id,
        at: artifactComment.createdAt,
        body: "Columns too narrow.",
        replyToId: null,
        ticket: null,
        artifact: { id: artifact.id, slug: artifact.slug, title: "Board" },
        document: null,
      },
      {
        kind: "version",
        id: `${artifact.id}:1`,
        at: expect.any(String),
        number: 1,
        of: {
          kind: "artifact",
          id: artifact.id,
          projectId: project.id,
          title: "Board",
          current: "Board",
          slug: artifact.slug,
          decisionNumber: null,
          ticket: null,
        },
      },
      expect.objectContaining({
        kind: "version",
        of: expect.objectContaining({ kind: "decision", id: decision.id, projectId: null, title: "Keep it", decisionNumber: 1 }),
      }),
      expect.objectContaining({ kind: "version", of: expect.objectContaining({ kind: "term", id: term.id, title: "Record" }) }),
      expect.objectContaining({
        kind: "version",
        number: 1,
        of: expect.objectContaining({ kind: "document", id: document.id, title: "Plan", slug: document.slug }),
      }),
      {
        kind: "comment",
        id: comment.id,
        at: comment.createdAt,
        body: "Looking into it.",
        replyToId: null,
        ticket: ticketRef,
        artifact: null,
        document: null,
      },
      {
        kind: "change",
        id: expect.any(String),
        at: expect.any(String),
        ticket: ticketRef,
        field: "priority",
        from: "none",
        to: "high",
        runId: run.id,
      },
      {
        kind: "run",
        id: run.id,
        at: run.startedAt,
        ticket: ticketRef,
        step: "Triage",
        model: run.model,
        state: "running",
        outcome: null,
        endedAt: null,
        transcript: null,
      },
    ]);
  });

  test("names a Run's Outcome and Transcript once it has them, and a later Version's number", async () => {
    const { ada, project, run, agent, asAgent } = await runningRun();
    const transcript = await upload("session_1", asAgent);
    tick();
    const document = await ok("POST", `/api/projects/${project.id}/documents`, asAgent, { title: "Plan", body: "One." });
    tick();
    await ok("PATCH", `/api/documents/${document.id}`, asAgent, { title: "Plan B", body: "Two.", baseVersion: 1 });
    tick();
    await ok("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "ready" });

    const { entries } = await ok("GET", `/api/agents/${agent.id}/record`, ada);

    const versions = entries.filter((e: { kind: string }) => e.kind === "version");
    expect(versions.map((v: { number: number; of: { title: string; current: string } }) => [v.number, v.of.title, v.of.current])).toEqual([
      [2, "Plan B", "Plan B"],
      [1, "Plan", "Plan B"],
    ]);
    const ran = entries.find((e: { kind: string }) => e.kind === "run");
    expect(ran).toMatchObject({ state: "finished", outcome: "ready", endedAt: expect.any(String) });
    expect(transcript.runId).toBe(run.id);
    expect(ran.transcript).toEqual({ id: transcript.id, slug: transcript.slug });
  });

  test("comes in pages that together list every entry once, in order", async () => {
    const { ada, ticket, agent, asAgent } = await runningRun();
    // Several at the same instant, so pages are cut between entries of one time.
    for (let i = 1; i <= 5; i++) {
      await ok("POST", `/api/tickets/${ticket.id}/comments`, asAgent, { body: `Note ${i}` });
      if (i % 2 === 0) tick();
    }

    const whole = (await ok("GET", `/api/agents/${agent.id}/record`, ada)).entries;
    const paged = await wholeRecord(agent.id, ada, 2);

    expect(whole).toHaveLength(6);
    expect(paged).toEqual(whole);
    expect(whole.filter((e: { kind: string }) => e.kind === "comment").map((e: { body: string }) => e.body)).toEqual([
      "Note 5",
      "Note 4",
      "Note 3",
      "Note 2",
      "Note 1",
    ]);
    const first = await ok("GET", `/api/agents/${agent.id}/record?limit=2`, ada);
    expect(first.next).toEqual(expect.any(String));
    expect((await call("GET", `/api/agents/${agent.id}/record?before=nonsense`, ada)).json.error.code).toBe("invalid_cursor");
  });

  test("any member sees it, leaving out what they can't read", async () => {
    const { workspace, ada, ticket, agent, asAgent } = await runningRun();
    const bea = await addMember(cronk, ada.cookie, workspace.id, "bea@example.com");
    const secret = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Secret", key: "SEC" });
    const hidden = await ok("POST", `/api/projects/${secret.id}/tickets`, ada, { title: "Hush" });
    await ok("PUT", `/api/projects/${secret.id}/access`, ada, { visibility: "private", users: [] });
    tick();
    await ok("POST", `/api/tickets/${hidden.id}/comments`, asAgent, { body: "Secret note." });
    tick();
    await ok("POST", `/api/projects/${secret.id}/documents`, asAgent, { title: "Secret plan" });
    tick();
    const board = await ok("POST", `/api/projects/${secret.id}/artifacts`, asAgent, { title: "Secret board", files: page("x") });
    tick();
    await ok("POST", `/api/artifacts/${board.id}/comments`, asAgent, { body: "On the secret board." });
    tick();
    await ok("POST", `/api/tickets/${ticket.id}/comments`, asAgent, { body: "Open note." });
    const kinds = (entries: { kind: string; body?: string; of?: { title: string } }[]) =>
      entries.map((e) => e.body ?? e.of?.title ?? e.kind);

    const asAda = await ok("GET", `/api/agents/${agent.id}/record`, ada);
    const asBea = await ok("GET", `/api/agents/${agent.id}/record`, { cookie: bea.cookie });

    expect(kinds(asAda.entries)).toEqual(["Open note.", "On the secret board.", "Secret board", "Secret plan", "Secret note.", "run"]);
    expect(kinds(asBea.entries)).toEqual(["Open note.", "run"]);
  });

  test("an Agent reads any Agent's Record of its own Workspace, and nobody outside it does", async () => {
    const { workspace, ada, agent, asAgent } = await runningRun();
    const other = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "laptop" });
    const outsider = await ok("POST", "/api/workspaces", ada, { name: "Friends" });
    const stranger = await addMember(cronk, ada.cookie, outsider.id, "carl@example.com");

    expect((await ok("GET", `/api/agents/${other.id}/record`, asAgent)).entries).toEqual([]);
    expect((await ok("GET", `/api/agents/${agent.id}/record`, asAgent)).entries).toHaveLength(1);
    expect((await call("GET", `/api/agents/${agent.id}/record`, { cookie: stranger.cookie })).status).toBe(404);
    expect((await call("GET", `/api/agents/not-an-id/record`, ada)).status).toBe(404);
  });

  test("stays readable after the Agent is removed", async () => {
    const { ada, ticket, agent, asAgent } = await runningRun();
    await ok("POST", `/api/tickets/${ticket.id}/comments`, asAgent, { body: "Before I go." });
    tick();

    await ok("DELETE", `/api/agents/${agent.id}`, ada);

    const record = await ok("GET", `/api/agents/${agent.id}/record`, ada);
    expect(record.agent).toMatchObject({ id: agent.id, name: "claude-max", removedAt: expect.any(String) });
    expect(record.entries.map((e: { kind: string }) => e.kind)).toEqual(["comment", "run"]);
    expect(record.entries[1]).toMatchObject({ state: "stopped" });
  });
});
