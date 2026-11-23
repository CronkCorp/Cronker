import { afterEach, describe, expect, test } from "vitest";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

/**
 * Token access (CRONK-123): Read, Write and Full, and a Full token moving Tickets as its Owner would; editing,
 * delegating, dismissing and relating any Ticket as its Owner would (CRONK-124).
 */

let cronk: StartedCronk;
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
  return { workspace, user, ada, project, ticket, agent, asWrite: bearer(write.secret), asFull: bearer(full.secret), status };
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
