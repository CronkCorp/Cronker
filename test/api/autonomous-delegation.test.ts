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

/**
 * Ada with a Project on the default board, a Ticket in Backlog, and her Agent `claude-max`
 * using her fake Runner, with a full token.
 */
async function adaWithAgent() {
  const { workspace, user } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Make it so" });
  const runner = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, ada, { runnerId: runner.id });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "cloud", access: "full" });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id as string;
  const asAgent = { headers: { authorization: `Bearer ${secret}` } };
  return { workspace, user, ada, project, ticket, agent, asAgent, status };
}

const ticketOf = (ticketId: string, as: Request) => ok("GET", `/api/tickets/${ticketId}`, as);

describe("the Autonomous Delegation setting", () => {
  test("a Ticket takes it from its Project when first delegated: off unless the Project changes it", async () => {
    const { ada, project, ticket, agent } = await adaWithAgent();
    expect(project.autonomousDelegationDefault).toBe(false);
    expect(ticket.autonomousDelegation).toBeNull();

    const delegated = await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id });
    expect(delegated.autonomousDelegation).toBe(false);

    const changed = await ok("PATCH", `/api/projects/${project.id}`, ada, { autonomousDelegationDefault: true });
    expect(changed.autonomousDelegationDefault).toBe(true);
    const second = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Second" });
    expect(second.autonomousDelegation).toBeNull();
    expect((await ok("PATCH", `/api/tickets/${second.id}`, ada, { delegateId: agent.id })).autonomousDelegation).toBe(true);

    // Only the first Delegation takes the default: the first Ticket keeps its own setting.
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: null });
    expect((await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id })).autonomousDelegation).toBe(false);

    // New Tickets that start delegated take it at once.
    await ok("PATCH", `/api/projects/${project.id}`, ada, { newTicketsDelegated: true });
    const born = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Born delegated" });
    expect(born.autonomousDelegation).toBe(true);
  });

  test("a User sets it on a Ticket, recorded on the timeline; an Agent can't", async () => {
    const { ada, ticket, asAgent } = await adaWithAgent();

    const set = await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { autonomousDelegation: true });
    expect(set.autonomousDelegation).toBe(true);
    const timeline = await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada);
    expect(timeline.at(-1)).toEqual(
      expect.objectContaining({ field: "autonomousDelegation", from: null, to: true, actor: expect.objectContaining({ kind: "user" }) }),
    );

    const byAgent = await call("PATCH", `/api/tickets/${ticket.id}`, asAgent, { autonomousDelegation: false });
    expect(byAgent.status).toBe(403);
    expect(byAgent.json.error.code).toBe("agent_not_allowed");
    expect((await ticketOf(ticket.id, ada)).autonomousDelegation).toBe(true);
  });

  test("Sub-Tickets take their parent's, including ones made Sub-Tickets later, and follow its changes", async () => {
    const { ada, project, ticket: parent, agent } = await adaWithAgent();
    const child = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Child" });
    const grandchild = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Grandchild" });
    await ok("PATCH", `/api/tickets/${grandchild.id}`, ada, { parentId: child.id });
    await ok("PATCH", `/api/tickets/${child.id}`, ada, { parentId: parent.id });
    await ok("PATCH", `/api/projects/${project.id}`, ada, { autonomousDelegationDefault: true });

    // The parent's first Delegation sets it, and its Sub-Tickets take it.
    await ok("PATCH", `/api/tickets/${parent.id}`, ada, { delegateId: agent.id });
    expect((await ticketOf(child.id, ada)).autonomousDelegation).toBe(true);
    expect((await ticketOf(grandchild.id, ada)).autonomousDelegation).toBe(true);

    await ok("PATCH", `/api/tickets/${parent.id}`, ada, { autonomousDelegation: false });
    expect((await ticketOf(child.id, ada)).autonomousDelegation).toBe(false);
    expect((await ticketOf(grandchild.id, ada)).autonomousDelegation).toBe(false);
    const timeline = await ok("GET", `/api/tickets/${grandchild.id}/timeline`, ada);
    expect(timeline.at(-1)).toEqual(expect.objectContaining({ field: "autonomousDelegation", from: true, to: false }));

    // A Ticket made a Sub-Ticket later takes its new parent's, even over its own.
    const later = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Later" });
    await ok("PATCH", `/api/tickets/${later.id}`, ada, { autonomousDelegation: true });
    const joined = await ok("PATCH", `/api/tickets/${later.id}`, ada, { parentId: child.id });
    expect(joined.autonomousDelegation).toBe(false);
    await ok("PATCH", `/api/tickets/${parent.id}`, ada, { autonomousDelegation: true });
    expect((await ticketOf(later.id, ada)).autonomousDelegation).toBe(true);
  });
});
