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

async function call(method: string, path: string, cookie: string, body?: unknown) {
  const response = await cronk.request(method, path, { cookie, body });
  return { status: response.status, json: response.status === 204 ? null : await response.json() };
}

async function ok(method: string, path: string, cookie: string, body?: unknown) {
  const response = await call(method, path, cookie, body);
  expect(response.status, `${method} ${path}: ${JSON.stringify(response.json)}`).toBeLessThan(300);
  return response.json;
}

/** Ada with a Project, a Ticket in Backlog, and her Agent `claude-max` using her fake Runner, which says it isn't cloud. */
async function adaWithAgent() {
  const { workspace } = await setUp(cronk);
  const ada = await signIn(cronk);
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Touch the laptop" });
  const runner = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, ada, { runnerId: runner.id });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id as string;
  return { workspace, ada, project, ticket, runner, agent, status };
}

const localOnlyRefused = (key: string) => ({
  code: "local_only_ticket",
  message: `${key} is labelled local-only: it can't run in a cloud session, and claude-max uses Fake, a cloud Runner.`,
});

describe("telling cloud Agents apart", () => {
  test("an Agent and its Runner say whether the Runner's kind runs in the cloud; an Agent with no Runner isn't cloud", async () => {
    const { workspace, ada, runner, agent } = await adaWithAgent();
    expect(agent.cloud).toBe(false);
    expect((await ok("GET", "/api/runners", ada)).find((r: { id: string }) => r.id === runner.id).cloud).toBe(false);

    cronk.runner.cloud = true;
    const agents = await ok("GET", `/api/workspaces/${workspace.id}/agents`, ada);
    expect(agents.find((a: { id: string }) => a.id === agent.id).cloud).toBe(true);
    expect((await ok("GET", "/api/runners", ada)).find((r: { id: string }) => r.id === runner.id).cloud).toBe(true);

    const subscription = await ok("POST", "/api/runners", ada, { name: "Max", kind: "subscription" });
    expect(subscription.cloud).toBe(true);

    const unpointed = await ok("PATCH", `/api/agents/${agent.id}`, ada, { runnerId: null });
    expect(unpointed.cloud).toBe(false);
    const handConnected = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "laptop" });
    expect(handConnected).toEqual(expect.objectContaining({ runnerId: null, cloud: false }));
  });
});

describe("delegating a local-only Ticket", () => {
  test("to a cloud Agent is refused, saying why, with the Label matched ignoring case", async () => {
    const { ada, ticket, agent } = await adaWithAgent();
    cronk.runner.cloud = true;
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { labels: ["Local-Only"] });

    const refused = await call("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id });

    expect(refused.status).toBe(409);
    expect(refused.json.error).toEqual(expect.objectContaining(localOnlyRefused("CRONK-1")));
    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).delegateId).toBeNull();
  });

  test("labelling a Ticket local-only while a cloud Agent is its Delegate is refused", async () => {
    const { ada, ticket, agent } = await adaWithAgent();
    cronk.runner.cloud = true;
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id });

    const refused = await call("PATCH", `/api/tickets/${ticket.id}`, ada, { labels: ["bug", "local-only"] });

    expect(refused.status).toBe(409);
    expect(refused.json.error).toEqual(expect.objectContaining(localOnlyRefused("CRONK-1")));
    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).labels).toEqual([]);
  });

  test("to an Agent whose Runner isn't cloud, or that has none, goes ahead and gets its Run", async () => {
    const { ada, ticket, agent, status } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { labels: ["local-only"] });

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });

    const [run] = await ok("GET", `/api/tickets/${ticket.id}/runs`, ada);
    expect(run.state).toBe("running");
    expect(cronk.runner.starts).toHaveLength(1);
  });

  test("without the Label, a cloud Agent takes the Ticket and starts its Run as before", async () => {
    const { ada, ticket, agent, status } = await adaWithAgent();
    cronk.runner.cloud = true;

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { labels: ["bug"], delegateId: agent.id, statusId: status("Triage") });

    const [run] = await ok("GET", `/api/tickets/${ticket.id}/runs`, ada);
    expect(run.state).toBe("running");
    expect(cronk.runner.starts).toHaveLength(1);
  });
});

describe("launching a Run on a local-only Ticket", () => {
  test("through a cloud Runner is refused with the reason, and the Runner isn't asked to start it", async () => {
    const { ada, ticket, agent, status } = await adaWithAgent();
    // Delegated while its Runner wasn't cloud, as when its Agent is pointed at a cloud Runner later.
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { labels: ["local-only"], delegateId: agent.id });
    cronk.runner.cloud = true;

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Triage") });

    const [run] = await ok("GET", `/api/tickets/${ticket.id}/runs`, ada);
    expect(run).toEqual(
      expect.objectContaining({
        state: "refused",
        endReason: expect.stringContaining("CRONK-1 is labelled local-only: it can't run in a cloud session"),
      }),
    );
    expect(cronk.runner.starts).toEqual([]);
  });
});
