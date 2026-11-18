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
});
