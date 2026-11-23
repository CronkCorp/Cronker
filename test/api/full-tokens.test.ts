import { afterEach, describe, expect, test } from "vitest";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

/** Token access (CRONK-123): Read, Write and Full, and a Full token moving Tickets as its Owner would. */

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

  test("a Write token is refused with full_token_needed, and a Full token's move goes alone", async () => {
    const { ada, ticket, asWrite, asFull, status } = await adaWithAgent();

    const byWrite = await call("PATCH", `/api/tickets/${ticket.id}`, asWrite, { statusId: status("Canceled") });
    expect(byWrite.status).toBe(403);
    expect(byWrite.json.error).toEqual({
      code: "full_token_needed",
      message: "claude-max's token is Write, and moving a Ticket needs a Full token.",
      rule: expect.stringContaining("An Agent takes this act only with a Full token"),
      advice: expect.stringContaining("ada@example.com"),
    });
    // The Status alone: the other fields keep today's Agent rules.
    const mixed = await call("PATCH", `/api/tickets/${ticket.id}`, asFull, { statusId: status("Canceled"), title: "Gone" });
    expect(mixed.status).toBe(403);
    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).statusId).toBe(status("Backlog"));
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
