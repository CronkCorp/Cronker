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

async function call(method: string, path: string, cookie: string, body?: unknown) {
  const response = await cronk.request(method, path, { cookie, body });
  return { status: response.status, json: response.status === 204 ? null : await response.json() };
}

async function ok(method: string, path: string, cookie: string, body?: unknown) {
  const response = await call(method, path, cookie, body);
  expect(response.status, `${method} ${path}: ${JSON.stringify(response.json)}`).toBeLessThan(300);
  return response.json;
}

/** Ada with a Project, a Ticket in Backlog and an Agent of her own. */
async function adaWithTicket() {
  const { workspace, user } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, cookie, { name: "Cronker", key: "CRONK" });
  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, cookie, { title: "Make it so" });
  const agent = await ok("POST", `/api/workspaces/${workspace.id}/agents`, cookie, { name: "claude-max" });
  return { workspace, user, cookie, project, ticket, agent };
}

describe("delegating a Ticket", () => {
  test("delegating an unassigned Ticket to one of your Agents assigns you", async () => {
    const { user, cookie, ticket, agent } = await adaWithTicket();

    const delegated = await ok("PATCH", `/api/tickets/${ticket.id}`, cookie, { delegateId: agent.id });

    expect(delegated).toEqual(expect.objectContaining({ assigneeId: user.id, delegateId: agent.id }));
    const timeline = await ok("GET", `/api/tickets/${ticket.id}/timeline`, cookie);
    expect(timeline.slice(1).map((c: { field: string; to: unknown }) => [c.field, c.to])).toEqual([
      ["assignee", { id: user.id, name: "ada@example.com" }],
      ["delegate", { id: agent.id, name: "claude-max" }],
    ]);
  });

  test("only your own Agents take your Tickets, and only the Assignee delegates", async () => {
    const { workspace, user, cookie, ticket, agent } = await adaWithTicket();
    const bea = await addMember(cronk, cookie, workspace.id, "bea@example.com");
    const beasAgent = await ok("POST", `/api/workspaces/${workspace.id}/agents`, bea.cookie, { name: "bea-bot" });

    const toOthers = await call("PATCH", `/api/tickets/${ticket.id}`, cookie, { delegateId: beasAgent.id });
    expect(toOthers.status).toBe(403);
    expect(toOthers.json.error.code).toBe("not_your_agent");

    await ok("PATCH", `/api/tickets/${ticket.id}`, cookie, { assigneeId: user.id });
    const notAssignee = await call("PATCH", `/api/tickets/${ticket.id}`, bea.cookie, { delegateId: beasAgent.id });
    expect(notAssignee.status).toBe(409);
    expect(notAssignee.json.error).toEqual({
      code: "delegate_not_assignees",
      message: expect.stringContaining("CRONK-1 is assigned to ada@example.com"),
    });

    // Assigning herself in the same edit lets Bea delegate it.
    const taken = await ok("PATCH", `/api/tickets/${ticket.id}`, bea.cookie, { assigneeId: bea.user.id, delegateId: beasAgent.id });
    expect(taken).toEqual(expect.objectContaining({ assigneeId: bea.user.id, delegateId: beasAgent.id }));
    const gone = await call("PATCH", `/api/tickets/${ticket.id}`, cookie, { delegateId: "00000000-0000-0000-0000-000000000000" });
    expect(gone.json.error.code).toBe("unknown_agent");
    expect(agent).toBeDefined();
  });

  test("a new Assignee who doesn't own the Delegate removes it; undelegating clears it", async () => {
    const { workspace, user, cookie, ticket, agent } = await adaWithTicket();
    const bea = await addMember(cronk, cookie, workspace.id, "bea@example.com");
    await ok("PATCH", `/api/tickets/${ticket.id}`, cookie, { delegateId: agent.id });

    const reassigned = await ok("PATCH", `/api/tickets/${ticket.id}`, cookie, { assigneeId: bea.user.id });
    expect(reassigned).toEqual(expect.objectContaining({ assigneeId: bea.user.id, delegateId: null }));
    const timeline = await ok("GET", `/api/tickets/${ticket.id}/timeline`, cookie);
    expect(timeline.at(-1)).toEqual(
      expect.objectContaining({ field: "delegate", from: { id: agent.id, name: "claude-max" }, to: null }),
    );

    await ok("PATCH", `/api/tickets/${ticket.id}`, cookie, { assigneeId: user.id, delegateId: agent.id });
    const kept = await ok("PATCH", `/api/tickets/${ticket.id}`, cookie, { title: "Still mine" });
    expect(kept.delegateId).toBe(agent.id);
    const undelegated = await ok("PATCH", `/api/tickets/${ticket.id}`, cookie, { delegateId: null });
    expect(undelegated).toEqual(expect.objectContaining({ assigneeId: user.id, delegateId: null }));
  });

  test("an Agent never changes Delegation", async () => {
    const { cookie, ticket, agent } = await adaWithTicket();
    const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, cookie, { name: "cloud", access: "full" });

    const response = await cronk.request("PATCH", `/api/tickets/${ticket.id}`, {
      headers: { authorization: `Bearer ${secret}` },
      body: { delegateId: agent.id },
    });

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("agent_not_allowed");
  });
});

describe("Projects whose new Tickets start delegated", () => {
  test("off by default; when on, a new Ticket is delegated to its creator's Agent and assigned to them", async () => {
    const { user, cookie, project, agent } = await adaWithTicket();
    expect(project.newTicketsDelegated).toBe(false);

    const changed = await ok("PATCH", `/api/projects/${project.id}`, cookie, { newTicketsDelegated: true });
    expect(changed.newTicketsDelegated).toBe(true);
    const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, cookie, { title: "Born delegated" });

    expect(ticket).toEqual(expect.objectContaining({ assigneeId: user.id, delegateId: agent.id }));
  });

  test("a creator without an Agent gets an undelegated Ticket", async () => {
    const { workspace, cookie, project } = await adaWithTicket();
    const bea = await addMember(cronk, cookie, workspace.id, "bea@example.com");
    await ok("PATCH", `/api/projects/${project.id}`, cookie, { newTicketsDelegated: true });

    const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, bea.cookie, { title: "No Agent" });

    expect(ticket).toEqual(expect.objectContaining({ assigneeId: null, delegateId: null }));
  });
});
