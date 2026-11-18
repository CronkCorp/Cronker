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

/** A member's Agent `name` in the Workspace, using a fake Runner of theirs, with a full token. */
async function agentOf(as: Request, workspaceId: string, name: string) {
  const runner = await ok("POST", "/api/runners", as, { name: "Fake", kind: "fake" });
  const created = await ok("POST", `/api/workspaces/${workspaceId}/agents`, as, { name });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, as, { runnerId: runner.id });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, as, { name: "cloud", access: "full" });
  return { ...agent, as: { headers: { authorization: `Bearer ${secret}` } } };
}

/**
 * Ada's Workspace with a Project on the default board, and Bea as a member with her Agent `bea-claude`,
 * whose Run on Bea's Ticket CRONK-1 is running in Triage.
 */
async function beaAtWork() {
  const { workspace, user } = await setUp(cronk);
  const ada = { id: user.id, cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id as string;
  const added = await addMember(cronk, ada.cookie, workspace.id, "bea@example.com");
  const bea = { id: added.user.id, cookie: added.cookie };
  const agent = await agentOf(bea, workspace.id, "bea-claude");
  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, bea, { title: "Bea's work" });
  await ok("PATCH", `/api/tickets/${ticket.id}`, bea, { delegateId: agent.id, statusId: status("Triage") });
  const [run] = await ok("GET", `/api/tickets/${ticket.id}/runs`, ada);
  const remove = (userId = bea.id) => ok("DELETE", `/api/workspaces/${workspace.id}/members/${userId}`, ada);
  return { workspace, project, status, ada, bea, agent, ticket, run, remove };
}

describe("removing a User from a Workspace", () => {
  test("stops their Agents' running Runs there, asking the Runner to stop them too", async () => {
    const { ada, ticket, run, remove } = await beaAtWork();
    expect(run.state).toBe("running");

    await remove();

    const [stopped] = await ok("GET", `/api/tickets/${ticket.id}/runs`, ada);
    expect(stopped).toMatchObject({ id: run.id, state: "stopped", endReason: "ada@example.com removed bea@example.com from the Workspace." });
    expect(cronk.runner.stops.map((s) => s.runId)).toEqual([run.id]);
  });

  test("refuses their Agents in that Workspace afterwards", async () => {
    const { ticket, agent, remove } = await beaAtWork();
    expect((await call("GET", `/api/tickets/${ticket.id}`, agent.as)).status).toBe(200);

    await remove();

    const refused = await call("GET", `/api/tickets/${ticket.id}`, agent.as);
    expect(refused).toEqual({ status: 401, json: { error: expect.objectContaining({ code: "invalid_token" }) } });
  });

  test("unassigns and undelegates every Ticket they were Assignee of, as the Admin's Changes", async () => {
    const { ada, bea, project, ticket, agent, remove } = await beaAtWork();
    const idle = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Bea's later work" });
    await ok("PATCH", `/api/tickets/${idle.id}`, ada, { assigneeId: bea.id });
    const adas = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Ada's work" });
    await ok("PATCH", `/api/tickets/${adas.id}`, ada, { assigneeId: ada.id });

    await remove();

    for (const t of [ticket, idle]) {
      expect(await ok("GET", `/api/tickets/${t.id}`, ada)).toMatchObject({ assigneeId: null, delegateId: null });
    }
    expect(await ok("GET", `/api/tickets/${adas.id}`, ada)).toMatchObject({ assigneeId: ada.id });
    const changes = await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada);
    const byAda = { kind: "user", id: ada.id, name: "ada@example.com" };
    expect(changes.slice(-2)).toMatchObject([
      { actor: byAda, field: "assignee", from: { id: bea.id, name: "bea@example.com" }, to: null },
      { actor: byAda, field: "delegate", from: { id: agent.id, name: "bea-claude" }, to: null },
    ]);
  });

  test("puts their Tickets in every Admin's Inbox to be reassigned, and no one else's", async () => {
    const { workspace, ada, bea, project, ticket, remove } = await beaAtWork();
    const idle = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Bea's later work" });
    await ok("PATCH", `/api/tickets/${idle.id}`, ada, { assigneeId: bea.id });
    const cy = await addMember(cronk, ada.cookie, workspace.id, "cy@example.com");
    await ok("PATCH", `/api/workspaces/${workspace.id}/members/${cy.user.id}`, ada, { isAdmin: true });
    const dee = await addMember(cronk, ada.cookie, workspace.id, "dee@example.com");
    const inbox = (as: Request) => ok("GET", `/api/workspaces/${workspace.id}/inbox`, as);

    await remove();

    const formerAssignee = { id: bea.id, email: "bea@example.com", githubLogin: null };
    const expected = {
      count: 2,
      items: [
        { kind: "reassign", ticket: expect.objectContaining({ id: ticket.id, key: "CRONK-1", assigneeId: null }), formerAssignee },
        { kind: "reassign", ticket: expect.objectContaining({ id: idle.id, key: "CRONK-2", assigneeId: null }), formerAssignee },
      ],
    };
    expect(await inbox(ada)).toEqual(expected);
    expect(await inbox({ cookie: cy.cookie })).toEqual(expected);
    expect(await inbox({ cookie: dee.cookie })).toEqual({ count: 0, items: [] });
  });

  test("assigning such a Ticket, or delegating it, takes it out of the Admins' Inbox", async () => {
    const { workspace, ada, bea, project, ticket, remove } = await beaAtWork();
    const idle = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Bea's later work" });
    await ok("PATCH", `/api/tickets/${idle.id}`, ada, { assigneeId: bea.id });
    const dee = await addMember(cronk, ada.cookie, workspace.id, "dee@example.com");
    const adasAgent = await agentOf(ada, workspace.id, "ada-claude");
    const inbox = () => ok("GET", `/api/workspaces/${workspace.id}/inbox`, ada);
    await remove();

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { assigneeId: dee.user.id });
    expect((await inbox()).items.map((i: { ticket: { key: string } }) => i.ticket.key)).toEqual(["CRONK-2"]);

    await ok("PATCH", `/api/tickets/${idle.id}`, ada, { delegateId: adasAgent.id });
    expect(await inbox()).toEqual({ count: 0, items: [] });
    expect(await ok("GET", `/api/tickets/${idle.id}`, ada)).toMatchObject({ assigneeId: ada.id, delegateId: adasAgent.id });
  });
});
