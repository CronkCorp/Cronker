import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, test } from "vitest";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

/**
 * Token access (CRONK-123): Read, Write and Full, and a Full token moving Tickets as its Owner would; editing,
 * delegating, dismissing and relating any Ticket as its Owner would (CRONK-124); and answering and dismissing
 * Questions and retrying Runs (CRONK-125).
 */

let cronk: StartedCronk;
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await cronk?.stop();
});

async function connect(token: string) {
  const client = new Client({ name: "cronk-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", cronk.url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function tool(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const [content] = result.content as { type: string; text: string }[];
  return { isError: result.isError ?? false, json: JSON.parse(content!.text) };
}

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

const bearer = (secret: string): Request => ({ headers: { authorization: `Bearer ${secret}` } });

/**
 * Ada with a Project on the default board, a Ticket CRONK-1 in Backlog, and her Agent `claude-max` on her fake Runner,
 * with a Write and a Full token.
 */
async function adaWithAgent() {
  cronk = await startCronk();
  const { workspace, user } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Make it so" });
  const runner = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, ada, { runnerId: runner.id });
  const write = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "cloud", access: "write" });
  const full = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "laptop", access: "full" });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id as string;
  return {
    workspace,
    user,
    ada,
    project,
    ticket,
    agent,
    asWrite: bearer(write.secret),
    asFull: bearer(full.secret),
    fullSecret: full.secret as string,
    status,
  };
}

const runsOf = (ticketId: string, as: Request) => ok("GET", `/api/tickets/${ticketId}/runs`, as);
const moves = async (ticketId: string, as: Request) =>
  ((await ok("GET", `/api/tickets/${ticketId}/timeline`, as)) as { field: string; actor: { name: string }; runId: string | null; to: { name: string } }[])
    .filter((c) => c.field === "status")
    .map((c) => ({ by: c.actor.name, runId: c.runId, to: c.to.name }));

describe("the upgrade", () => {
  test("a token stored as full before it is Write after it, acting exactly as before", async () => {
    cronk = await startCronk({ migrateBefore: "0079_token_levels.sql" });
    const { workspace } = await setUp(cronk);
    const ada = { cookie: await signIn(cronk) };
    const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
    const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Make it so" });
    const agent = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
    const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "laptop", access: "full" });

    await cronk.upgrade();

    const listed = await ok("GET", `/api/agents/${agent.id}/tokens`, ada);
    expect(listed.map((t: { name: string; access: string }) => [t.name, t.access])).toEqual([["laptop", "write"]]);
    expect((await ok("GET", "/api/agent", bearer(secret))).access).toBe("write");
    const canceled = project.statuses.find((s: { kind: string }) => s.kind === "canceled").id;
    const moved = await call("PATCH", `/api/tickets/${ticket.id}`, bearer(secret), { statusId: canceled });
    expect([moved.status, moved.json.error.code]).toEqual([403, "full_token_needed"]);
    // A token stored with no level is Write.
    await cronk.stage("insert into agent_tokens (agent_id, name, token_hash, created_at) values ($1, 'bare', 'x', now())", [agent.id]);
    const accesses = (await ok("GET", `/api/agents/${agent.id}/tokens`, ada)).map((t: { access: string }) => t.access);
    expect(accesses).toEqual(["write", "write"]);
  });
});

describe("a Full token moving a Ticket", () => {
  test("moves it to Canceled, as a Change by the Agent with no Run", async () => {
    const { ada, ticket, asFull, status } = await adaWithAgent();

    const moved = await ok("PATCH", `/api/tickets/${ticket.id}`, asFull, { statusId: status("Canceled") });

    expect(moved.statusId).toBe(status("Canceled"));
    expect(await moves(ticket.id, ada)).toEqual([{ by: "claude-max", runId: null, to: "Canceled" }]);
  });

  test("into a Status with a Step starts the delegated Ticket's Run, and out of it stops the Run", async () => {
    const { ada, ticket, agent, asFull, status } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id });

    await ok("PATCH", `/api/tickets/${ticket.id}`, asFull, { statusId: status("Triage") });
    const [run] = await runsOf(ticket.id, ada);
    expect(run).toMatchObject({ state: "running", step: { name: "Triage" } });

    await ok("PATCH", `/api/tickets/${ticket.id}`, asFull, { statusId: status("Backlog") });
    const [stopped] = await runsOf(ticket.id, ada);
    expect(stopped).toMatchObject({ id: run.id, state: "stopped", endReason: "claude-max moved CRONK-1 to Backlog." });
    expect(await moves(ticket.id, ada)).toEqual([
      { by: "claude-max", runId: null, to: "Triage" },
      { by: "claude-max", runId: null, to: "Backlog" },
    ]);
  });

  test("a Write token is refused with full_token_needed, and a Full token moves it along with other fields", async () => {
    const { ada, ticket, asWrite, asFull, status } = await adaWithAgent();

    const byWrite = await call("PATCH", `/api/tickets/${ticket.id}`, asWrite, { statusId: status("Canceled") });
    expect(byWrite.status).toBe(403);
    expect(byWrite.json.error).toEqual({
      code: "full_token_needed",
      message: "claude-max's token is Write, and moving a Ticket needs a Full token.",
      rule: expect.stringContaining("An Agent takes this act only with a Full token"),
      advice: expect.stringContaining("ada@example.com"),
    });
    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).statusId).toBe(status("Backlog"));
    // A Full token moves it along with other fields, as its Owner would.
    const mixed = await ok("PATCH", `/api/tickets/${ticket.id}`, asFull, { statusId: status("Canceled"), title: "Gone" });
    expect(mixed).toMatchObject({ statusId: status("Canceled"), title: "Gone" });
  });

  test("is bounded by the Project's Agent Access and its Owner's Access", async () => {
    const { workspace, ada, project, ticket, asFull, status } = await adaWithAgent();
    await ok("PUT", `/api/projects/${project.id}/access`, ada, { visibility: "open", users: [], agentAccess: "read" });

    const underAgentAccess = await call("PATCH", `/api/tickets/${ticket.id}`, asFull, { statusId: status("Canceled") });
    expect([underAgentAccess.status, underAgentAccess.json.error.code]).toEqual([403, "read_access"]);

    await ok("PUT", `/api/projects/${project.id}/access`, ada, { visibility: "open", users: [], agentAccess: "write" });
    const bea = await addMember(cronk, ada.cookie, workspace.id, "bea@example.com");
    await cronk.stage(
      "insert into project_members (project_id, workspace_id, user_id, level, created_at) values ($1, $2, $3, 'read', now())",
      [project.id, workspace.id, bea.user.id],
    );
    const beasAgent = await ok("POST", `/api/workspaces/${workspace.id}/agents`, { cookie: bea.cookie }, { name: "bea-claude" });
    const beasToken = await ok("POST", `/api/agents/${beasAgent.id}/tokens`, { cookie: bea.cookie }, { name: "laptop", access: "full" });
    const underOwner = await call("PATCH", `/api/tickets/${ticket.id}`, bearer(beasToken.secret), { statusId: status("Canceled") });
    expect([underOwner.status, underOwner.json.error.code]).toEqual([403, "read_access"]);
    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).statusId).toBe(status("Backlog"));
  });
});

/** Each Change on the Ticket's timeline for the fields given: who made it, with which Run, and to what. */
const changesTo = async (ticketId: string, as: Request, ...fields: string[]) =>
  ((await ok("GET", `/api/tickets/${ticketId}/timeline`, as)) as { field: string; actor: { name: string }; runId: string | null; to: unknown }[])
    .filter((c) => fields.includes(c.field))
    .map((c) => ({ field: c.field, by: c.actor.name, runId: c.runId, to: c.to }));

const refusal = (response: { status: number; json: { error: { code: string } } }) => [response.status, response.json.error.code];

describe("a Full token editing a Ticket", () => {
  test("edits a running Ticket's title and Assignee, as Changes by the Agent with no Run", async () => {
    const { workspace, ada, ticket, agent, asFull, status } = await adaWithAgent();
    const bea = await addMember(cronk, ada.cookie, workspace.id, "bea@example.com");
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });
    const [run] = await runsOf(ticket.id, ada);
    expect(run.state).toBe("running");

    const edited = await ok("PATCH", `/api/tickets/${ticket.id}`, asFull, { title: "Make it so, properly", assigneeId: bea.user.id });

    expect(edited).toMatchObject({ title: "Make it so, properly", assigneeId: bea.user.id });
    expect((await changesTo(ticket.id, ada, "title", "assignee")).filter((c) => c.by === "claude-max")).toEqual([
      { field: "title", by: "claude-max", runId: null, to: "Make it so, properly" },
      { field: "assignee", by: "claude-max", runId: null, to: expect.objectContaining({ id: bea.user.id }) },
    ]);
    // Bea doesn't own the Delegate, so the new Assignee removes it and its running Run stops, as on the Owner's edit.
    const [stopped] = await runsOf(ticket.id, ada);
    expect(stopped).toMatchObject({ id: run.id, state: "stopped", endReason: "claude-max undelegated CRONK-1." });
  });

  test("delegates a Ticket to another Agent of its Owner and undelegates it; another User's Agent is refused", async () => {
    const { workspace, ada, ticket, asFull } = await adaWithAgent();
    const helper = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "helper" });

    const delegated = await ok("PATCH", `/api/tickets/${ticket.id}`, asFull, { delegateId: helper.id, autonomousDelegation: true });
    // Unassigned, it is assigned the Owner, whose Agent the Delegate is.
    expect(delegated).toMatchObject({ delegateId: helper.id, assigneeId: expect.any(String), autonomousDelegation: true });
    await ok("PATCH", `/api/tickets/${ticket.id}`, asFull, { delegateId: null });
    expect(await changesTo(ticket.id, ada, "delegate", "autonomousDelegation")).toEqual([
      { field: "delegate", by: "claude-max", runId: null, to: expect.objectContaining({ name: "helper" }) },
      { field: "autonomousDelegation", by: "claude-max", runId: null, to: true },
      { field: "delegate", by: "claude-max", runId: null, to: null },
    ]);

    const bea = await addMember(cronk, ada.cookie, workspace.id, "bea@example.com");
    const beasAgent = await ok("POST", `/api/workspaces/${workspace.id}/agents`, { cookie: bea.cookie }, { name: "bea-claude" });
    const toBeas = await call("PATCH", `/api/tickets/${ticket.id}`, asFull, { delegateId: beasAgent.id });
    expect(refusal(toBeas)).toEqual([403, "not_your_agent"]);
  });

  test("makes Sub-Tickets of any Ticket and links Documents to it, outside any Run", async () => {
    const { ada, project, ticket, asFull } = await adaWithAgent();

    const sub = await ok("POST", `/api/projects/${project.id}/tickets`, asFull, { title: "A slice", parentId: ticket.id });
    expect(sub.parentId).toBe(ticket.id);
    const document = await ok("POST", `/api/projects/${project.id}/documents`, ada, { title: "Plan", body: "One." });
    await ok("POST", `/api/tickets/${ticket.id}/documents`, asFull, { documentId: document.id });
    expect((await ok("GET", `/api/tickets/${ticket.id}/documents`, ada)).map((d: { id: string }) => d.id)).toEqual([document.id]);
  });

  test("a Write token keeps today's Agent rules", async () => {
    const { workspace, ada, project, ticket, agent, asWrite } = await adaWithAgent();
    const helper = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "helper" });

    expect(refusal(await call("PATCH", `/api/tickets/${ticket.id}`, asWrite, { title: "Mine" }))).toEqual([403, "agent_field_not_allowed"]);
    const delegating = await call("PATCH", `/api/tickets/${ticket.id}`, asWrite, { delegateId: helper.id });
    expect(refusal(delegating)).toEqual([403, "agent_field_not_allowed"]);
    expect(delegating.json.error.advice).toContain("Full token");
    expect(refusal(await call("PATCH", `/api/tickets/${ticket.id}`, asWrite, { priority: "high" }))).toEqual([403, "no_running_run"]);
    const sub = await call("POST", `/api/projects/${project.id}/tickets`, asWrite, { title: "A slice", parentId: ticket.id });
    expect(refusal(sub)).toEqual([403, "no_running_run"]);
    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada))).toMatchObject({ title: "Make it so", delegateId: null });
    expect(agent.id).not.toBe(helper.id);
  });
});

describe("a Full token triaging", () => {
  test("dismisses a Discovered Ticket, adds a relates Relation and removes a block", async () => {
    const { ada, project, ticket, asWrite, asFull } = await adaWithAgent();
    const discovered = await ok("POST", `/api/projects/${project.id}/tickets`, asWrite, { title: "Found on the way" });
    expect(discovered.discovered.waiting).toBe(true);

    const dismissed = await ok("POST", `/api/tickets/${discovered.id}/dismiss`, asFull);
    expect(dismissed.discovered.waiting).toBe(false);
    expect(await changesTo(discovered.id, ada, "dismissed")).toEqual([{ field: "dismissed", by: "claude-max", runId: null, to: null }]);

    const relates = await ok("POST", `/api/tickets/${ticket.id}/relations`, asFull, { kind: "relatesTo", ticketKey: discovered.key });
    expect(relates).toMatchObject({ kind: "relatesTo", ticket: { id: discovered.id } });
    const block = await ok("POST", `/api/tickets/${ticket.id}/relations`, asFull, { kind: "blocks", ticketId: discovered.id });
    await ok("DELETE", `/api/tickets/${ticket.id}/relations/${block.id}`, asFull);

    const relations = await ok("GET", `/api/tickets/${ticket.id}/relations`, ada);
    expect(JSON.stringify(relations)).not.toContain(block.id);
    expect(await changesTo(ticket.id, ada, "relatesTo", "blocks")).toEqual([
      expect.objectContaining({ by: "claude-max", runId: null }),
      expect.objectContaining({ by: "claude-max", runId: null }),
      expect.objectContaining({ by: "claude-max", runId: null }),
    ]);
  });

  test("a Write token gets full_token_needed for dismissing and removing a Relation, and today's rules for relating", async () => {
    const { ada, project, ticket, asWrite } = await adaWithAgent();
    const discovered = await ok("POST", `/api/projects/${project.id}/tickets`, asWrite, { title: "Found on the way" });
    const other = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Another" });

    const dismissing = await call("POST", `/api/tickets/${discovered.id}/dismiss`, asWrite);
    expect(refusal(dismissing)).toEqual([403, "full_token_needed"]);
    expect(dismissing.json.error.message).toBe("claude-max's token is Write, and dismissing a Discovered Ticket needs a Full token.");

    // Its own waiting Discovered Ticket may still block, but not relate.
    const block = await ok("POST", `/api/tickets/${discovered.id}/relations`, asWrite, { kind: "blocks", ticketId: other.id });
    const relating = await call("POST", `/api/tickets/${discovered.id}/relations`, asWrite, { kind: "relatesTo", ticketId: ticket.id });
    expect(refusal(relating)).toEqual([403, "agent_adds_only_blocks"]);
    const unrelated = await call("POST", `/api/tickets/${ticket.id}/relations`, asWrite, { kind: "blocks", ticketId: other.id });
    expect(refusal(unrelated)).toEqual([403, "not_your_discovered_ticket"]);

    const removing = await call("DELETE", `/api/tickets/${discovered.id}/relations/${block.id}`, asWrite);
    expect(refusal(removing)).toEqual([403, "full_token_needed"]);
    expect((await ok("GET", `/api/tickets/${discovered.id}`, ada)).discovered.waiting).toBe(true);
  });
});

describe("human-only acts", () => {
  test("a Full token is refused Accept, Reopen, a Decision's status and resolving threads with human_only", async () => {
    const { ada, project, ticket, asFull } = await adaWithAgent();
    const humanOnly = (response: { status: number; json: { error: { code: string } } }) => [response.status, response.json.error.code];

    expect(humanOnly(await call("POST", `/api/tickets/${ticket.id}/accept`, asFull))).toEqual([403, "human_only"]);
    expect(humanOnly(await call("POST", `/api/tickets/${ticket.id}/reopen`, asFull, { comment: "Again." }))).toEqual([403, "human_only"]);

    const decision = await ok("POST", `/api/projects/${project.id}/decisions`, ada, { title: "Use Postgres" });
    const status = await call("PATCH", `/api/decisions/${decision.id}`, asFull, { baseVersion: 1, status: "accepted" });
    expect(humanOnly(status)).toEqual([403, "human_only"]);
    // Its text a Full token edits, as any Agent does.
    await ok("PATCH", `/api/decisions/${decision.id}`, asFull, { baseVersion: 1, body: "Because it's there." });

    const document = await ok("POST", `/api/projects/${project.id}/documents`, ada, { title: "Plan", body: "One." });
    const comment = await ok("POST", `/api/documents/${document.id}/comments`, ada, { body: "Why one?" });
    expect(humanOnly(await call("POST", `/api/comments/${comment.id}/resolve`, asFull))).toEqual([403, "human_only"]);
  });

  test("a Write token keeps today's refusals of them", async () => {
    const { ticket, asWrite } = await adaWithAgent();
    const accept = await call("POST", `/api/tickets/${ticket.id}/accept`, asWrite);
    expect([accept.status, accept.json.error.code]).toEqual([403, "agent_not_allowed"]);
  });
});

describe("a Full token deleting knowledge", () => {
  const file = (path: string, text: string) => ({ path, contentBase64: Buffer.from(text).toString("base64") });
  const codeOf = (response: { status: number; json: { error: { code: string } } }) => [response.status, response.json.error.code];

  /** A Document, a Term and an Artifact with two Versions, in Ada's Project. */
  async function knowledge(as: Request, projectId: string) {
    const document = await ok("POST", `/api/projects/${projectId}/documents`, as, { title: "Plan", body: "One." });
    const term = await ok("POST", `/api/projects/${projectId}/terms`, as, { name: "Ticket", definition: "Work." });
    const artifact = await ok("POST", `/api/projects/${projectId}/artifacts`, as, {
      title: "Prototype",
      files: [file("index.html", "<p>1</p>")],
    });
    await ok("PATCH", `/api/artifacts/${artifact.id}`, as, { baseVersion: 1, files: [file("index.html", "<p>2</p>")] });
    return { document, term, artifact };
  }

  test("deletes a Document, a Term, an Artifact Version and an Artifact", async () => {
    const { ada, project, asFull } = await adaWithAgent();
    const { document, term, artifact } = await knowledge(ada, project.id);

    await ok("DELETE", `/api/documents/${document.id}`, asFull);
    await ok("DELETE", `/api/terms/${term.id}`, asFull);
    await ok("DELETE", `/api/artifacts/${artifact.id}/versions/2`, asFull);
    expect((await ok("GET", `/api/artifacts/${artifact.id}`, ada)).version.number).toBe(1);
    await ok("DELETE", `/api/artifacts/${artifact.id}`, asFull);

    expect((await call("GET", `/api/documents/${document.id}`, ada)).status).toBe(404);
    expect((await call("GET", `/api/terms/${term.id}`, ada)).status).toBe(404);
    expect((await call("GET", `/api/artifacts/${artifact.id}`, ada)).status).toBe(404);
  });

  test("a Write token is refused each with full_token_needed, deleting nothing", async () => {
    const { ada, project, asWrite } = await adaWithAgent();
    const { document, term, artifact } = await knowledge(ada, project.id);

    for (const path of [
      `/api/documents/${document.id}`,
      `/api/terms/${term.id}`,
      `/api/artifacts/${artifact.id}/versions/2`,
      `/api/artifacts/${artifact.id}`,
    ]) {
      expect(codeOf(await call("DELETE", path, asWrite)), path).toEqual([403, "full_token_needed"]);
    }
    await ok("GET", `/api/documents/${document.id}`, ada);
    await ok("GET", `/api/terms/${term.id}`, ada);
    expect((await ok("GET", `/api/artifacts/${artifact.id}`, ada)).version.number).toBe(2);
  });

  test("is bounded by the Project's Agent Access and its Owner's Access", async () => {
    const { workspace, ada, project, asFull } = await adaWithAgent();
    const { document, term, artifact } = await knowledge(ada, project.id);
    const paths = [`/api/documents/${document.id}`, `/api/terms/${term.id}`, `/api/artifacts/${artifact.id}/versions/2`, `/api/artifacts/${artifact.id}`];
    await ok("PUT", `/api/projects/${project.id}/access`, ada, { visibility: "open", users: [], agentAccess: "read" });

    for (const path of paths) expect(codeOf(await call("DELETE", path, asFull)), path).toEqual([403, "read_access"]);

    await ok("PUT", `/api/projects/${project.id}/access`, ada, { visibility: "open", users: [], agentAccess: "write" });
    const bea = await addMember(cronk, ada.cookie, workspace.id, "bea@example.com");
    await cronk.stage(
      "insert into project_members (project_id, workspace_id, user_id, level, created_at) values ($1, $2, $3, 'read', now())",
      [project.id, workspace.id, bea.user.id],
    );
    const beasAgent = await ok("POST", `/api/workspaces/${workspace.id}/agents`, { cookie: bea.cookie }, { name: "bea-claude" });
    const beasToken = await ok("POST", `/api/agents/${beasAgent.id}/tokens`, { cookie: bea.cookie }, { name: "laptop", access: "full" });
    for (const path of paths) expect(codeOf(await call("DELETE", path, bearer(beasToken.secret))), path).toEqual([403, "read_access"]);
    await ok("GET", `/api/documents/${document.id}`, ada);
    await ok("GET", `/api/terms/${term.id}`, ada);
    expect((await ok("GET", `/api/artifacts/${artifact.id}`, ada)).version.number).toBe(2);
  });
});

describe("a Full token and its Transcripts", () => {
  async function upload(sessionId: string, text: string, as: Request) {
    const line = { type: "user", sessionId: "local-id", uuid: "u-1", timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: text } };
    const response = await fetch(`${cronk.url}/api/transcripts/sessions/${sessionId}`, {
      method: "PUT",
      headers: { "content-type": "application/x-ndjson", ...as.headers },
      body: JSON.stringify(line) + "\n",
    });
    expect(response.status).toBeLessThan(300);
    return response.json();
  }

  test("redacts and deletes one, each recorded with the Agent, and no Run, as who did it", async () => {
    const { ada, ticket, agent, asFull, status } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Triage") });
    const [run] = await runsOf(ticket.id, ada);
    const transcript = await upload("session_1", "The key is sk-secret-1234.", asFull);

    const redacted = await ok("POST", `/api/transcripts/${transcript.id}/redactions`, asFull, { text: "sk-secret-1234" });
    expect(redacted.redactions).toEqual([{ id: expect.any(String), addedBy: { id: agent.id, name: "claude-max" }, addedAt: expect.any(String) }]);

    await ok("DELETE", `/api/transcripts/${transcript.id}`, asFull);

    expect(await runsOf(ticket.id, ada)).toMatchObject([{ id: run.id, transcriptId: null, transcriptDeleted: true }]);
    const [deleted] = (await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada)).slice(-1);
    expect(deleted).toMatchObject({
      field: "transcriptDeleted",
      from: { runId: run.id, step: "Triage" },
      actor: { kind: "agent", name: "claude-max" },
      runId: null,
    });
  });

  test("a Write token is refused redacting and deleting with full_token_needed", async () => {
    const { ada, asWrite } = await adaWithAgent();
    const transcript = await upload("laptop-1", "The key is sk-secret-1234.", asWrite);

    const redacting = await call("POST", `/api/transcripts/${transcript.id}/redactions`, asWrite, { text: "sk-secret-1234" });
    expect([redacting.status, redacting.json.error.code]).toEqual([403, "full_token_needed"]);
    const deleting = await call("DELETE", `/api/transcripts/${transcript.id}`, asWrite);
    expect([deleting.status, deleting.json.error.code]).toEqual([403, "full_token_needed"]);
    expect((await ok("GET", `/api/transcripts/${transcript.id}`, ada)).redactions).toEqual([]);
  });
});

describe("a Full token and a Run's Question", () => {
  /** `adaWithAgent` with CRONK-1's Investigate Run, delegated to claude-max, having asked a Question. */
  async function asked() {
    const setup = await adaWithAgent();
    const { workspace, ada, ticket, agent, asWrite, status } = setup;
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Investigate") });
    const [run] = await runsOf(ticket.id, ada);
    await ok("POST", `/api/runs/${run.id}/finish`, asWrite, { outcome: "needs you", question: "Blue or green?" });
    const { items } = await ok("GET", `/api/workspaces/${workspace.id}/inbox`, ada);
    const { question } = items.find((item: { kind: string }) => item.kind === "question");
    return { ...setup, question: question as { id: string; commentId: string } };
  }

  test("answers it through answer_question: the Ticket goes back as the Agent's move and a new Run starts", async () => {
    const { workspace, ada, ticket, fullSecret, status, question } = await asked();

    const answered = await tool(await connect(fullSecret), "answer_question", {
      ticket: "CRONK-1",
      comment: question.commentId,
      body: "Green.",
    });

    expect(answered.isError, JSON.stringify(answered.json)).toBe(false);
    expect(answered.json).toEqual(expect.objectContaining({ body: "Green.", replyToId: question.commentId }));
    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).statusId).toBe(status("Investigate"));
    const runs = await runsOf(ticket.id, ada);
    expect(runs.map((r: { state: string }) => r.state)).toEqual(["finished", "running"]);
    expect((await moves(ticket.id, ada)).at(-1)).toEqual({ by: "claude-max", runId: null, to: "Investigate" });
    expect((await ok("GET", `/api/workspaces/${workspace.id}/inbox`, ada)).items).toEqual([]);
  });

  test("a Write token's reply is just a Comment, and it can't dismiss the Question; a Full token dismisses it", async () => {
    const { workspace, ada, ticket, asWrite, asFull, status, question } = await asked();

    await ok("POST", `/api/tickets/${ticket.id}/comments`, asWrite, { body: "Still wondering.", replyToId: question.commentId });
    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).statusId).toBe(status("Backlog"));
    const byWrite = await call("POST", `/api/questions/${question.id}/dismiss`, asWrite);
    expect([byWrite.status, byWrite.json.error.code]).toEqual([403, "full_token_needed"]);

    const byFull = await call("POST", `/api/questions/${question.id}/dismiss`, asFull);

    expect(byFull.status).toBe(204);
    const inbox = await ok("GET", `/api/workspaces/${workspace.id}/inbox`, ada);
    expect(inbox.items.filter((i: { kind: string }) => i.kind === "question")).toEqual([]);
    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).statusId).toBe(status("Backlog"));
  });
});

describe("a Full token retrying a Run", () => {
  test("retry_run starts a fresh Run; a Write token gets full_token_needed", async () => {
    const { ada, ticket, agent, asWrite, fullSecret, status } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });
    const [run] = await runsOf(ticket.id, ada);
    await cronk.runner.endWithoutFinishing(run.id, "The session crashed.");

    const byWrite = await call("POST", `/api/tickets/${ticket.id}/retry`, asWrite);
    expect([byWrite.status, byWrite.json.error.code]).toEqual([403, "full_token_needed"]);

    const retried = await tool(await connect(fullSecret), "retry_run", { ticket: "CRONK-1" });

    expect(retried.isError, JSON.stringify(retried.json)).toBe(false);
    const runs = await runsOf(ticket.id, ada);
    expect(runs.map((r: { state: string }) => r.state)).toEqual(["failed", "running"]);
    expect(retried.json.lastRun).toEqual(expect.objectContaining({ id: runs[1].id, state: "running" }));
  });

  test("is refused for a Delegate another User owns, as its Owner would be", async () => {
    const { workspace, ada, ticket, agent, status } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });
    const [run] = await runsOf(ticket.id, ada);
    await cronk.runner.endWithoutFinishing(run.id);
    const bea = await addMember(cronk, ada.cookie, workspace.id, "bea@example.com");
    const beasAgent = await ok("POST", `/api/workspaces/${workspace.id}/agents`, { cookie: bea.cookie }, { name: "bea-claude" });
    const beasToken = await ok("POST", `/api/agents/${beasAgent.id}/tokens`, { cookie: bea.cookie }, { name: "laptop", access: "full" });

    const refused = await call("POST", `/api/tickets/${ticket.id}/retry`, bearer(beasToken.secret));

    expect([refused.status, refused.json.error.code]).toEqual([403, "not_delegates_owner"]);
    expect(cronk.runner.starts).toHaveLength(1);
  });
});
