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

/** Ada with a Project on the default board and her Agent `claude-max` using her fake Runner, with a full token. */
async function adaWithAgent() {
  const { workspace, user } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const runner = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, ada, { runnerId: runner.id });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "cloud", access: "full" });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id as string;
  const asAgent = { headers: { authorization: `Bearer ${secret}` } };
  /** Creates a Ticket, a second later than the last. */
  const ticket = async (title: string) => {
    cronk.clock.advance(1000);
    return ok("POST", `/api/projects/${project.id}/tickets`, ada, { title });
  };
  /** Delegates the Ticket to claude-max and moves it to Triage, a second later than the last. */
  const delegateToTriage = async (ticketId: string, as: Request = ada, agentId: string = agent.id) => {
    cronk.clock.advance(1000);
    return ok("PATCH", `/api/tickets/${ticketId}`, as, { delegateId: agentId, statusId: status("Triage") });
  };
  /** Finishes the Ticket's running Run as its Agent, by default with `ready`, moving it from Triage to Ready. */
  const finish = async (ticketId: string, as: Request = asAgent, outcome = "ready") => {
    const runs = await ok("GET", `/api/tickets/${ticketId}/runs`, ada);
    const running = runs.find((r: { state: string }) => r.state === "running");
    return ok("POST", `/api/runs/${running.id}/finish`, as, { outcome });
  };
  return { workspace, user, ada, project, runner, agent, asAgent, status, ticket, delegateToTriage, finish };
}

/** Each Ticket on the board by key: the state of its latest Run, and what it waits for. */
async function board(projectId: string, as: Request) {
  const tickets = await ok("GET", `/api/projects/${projectId}/tickets`, as);
  return Object.fromEntries(
    tickets.map((t: { key: string; lastRun: { state: string } | null; waiting: string | null }) => [
      t.key,
      { run: t.lastRun?.state ?? null, waiting: t.waiting },
    ]),
  );
}

describe("a Runner's limit", () => {
  test("Runs beyond a Runner's default limit of 2 wait for a Runner slot", async () => {
    const { ada, project, ticket, delegateToTriage } = await adaWithAgent();
    for (const title of ["First", "Second", "Third"]) await delegateToTriage((await ticket(title)).id);

    expect(await board(project.id, ada)).toEqual({
      "CRONK-1": { run: "running", waiting: null },
      "CRONK-2": { run: "running", waiting: null },
      "CRONK-3": { run: null, waiting: "runnerSlot" },
    });
    expect(cronk.runner.starts.map((s) => s.ticket.key)).toEqual(["CRONK-1", "CRONK-2"]);
  });
});

describe("setting a Runner's limit", () => {
  test("its User sets it; a lower limit holds new Runs back, and a higher one starts those waiting", async () => {
    const { ada, project, runner, ticket, delegateToTriage } = await adaWithAgent();
    expect(await ok("GET", "/api/runners", ada)).toEqual([expect.objectContaining({ id: runner.id, limit: 2 })]);

    expect(await ok("PATCH", `/api/runners/${runner.id}`, ada, { limit: 1 })).toEqual(
      expect.objectContaining({ id: runner.id, limit: 1 }),
    );
    for (const title of ["First", "Second", "Third"]) await delegateToTriage((await ticket(title)).id);
    expect(cronk.runner.starts.map((s) => s.ticket.key)).toEqual(["CRONK-1"]);

    await ok("PATCH", `/api/runners/${runner.id}`, ada, { limit: 3 });

    expect(cronk.runner.starts.map((s) => s.ticket.key)).toEqual(["CRONK-1", "CRONK-2", "CRONK-3"]);
    expect(await board(project.id, ada)).toEqual({
      "CRONK-1": { run: "running", waiting: null },
      "CRONK-2": { run: "running", waiting: null },
      "CRONK-3": { run: "running", waiting: null },
    });
  });

  test("only its own User sets it, to at least 1", async () => {
    const { workspace, ada, runner } = await adaWithAgent();
    const bob = await addMember(cronk, ada.cookie!, workspace.id, "bob@example.com");

    const byBob = await call("PATCH", `/api/runners/${runner.id}`, { cookie: bob.cookie }, { limit: 5 });
    expect(byBob.status).toBe(404);
    expect((await call("PATCH", `/api/runners/${runner.id}`, ada, { limit: 0 })).status).toBe(400);
    expect(await ok("GET", "/api/runners", ada)).toEqual([expect.objectContaining({ limit: 2 })]);
  });
});

describe("the queue", () => {
  test("a freed slot goes to the waiting Ticket of highest Priority, then the one that entered its Status first", async () => {
    const { ada, runner, ticket, delegateToTriage, finish } = await adaWithAgent();
    await ok("PATCH", `/api/runners/${runner.id}`, ada, { limit: 1 });
    const first = await ticket("First");
    const low = await ticket("Low, waiting longest");
    const high = await ticket("High");
    const laterHigh = await ticket("High, arrived later");
    await ok("PATCH", `/api/tickets/${low.id}`, ada, { priority: "low" });
    for (const t of [first, low, high, laterHigh]) await delegateToTriage(t.id);
    // Priority counts as it is when the slot frees, not as it was on arrival.
    await ok("PATCH", `/api/tickets/${laterHigh.id}`, ada, { priority: "high" });
    await ok("PATCH", `/api/tickets/${high.id}`, ada, { priority: "high" });
    const started = () => cronk.runner.starts.map((s) => s.ticket.key);
    expect(started()).toEqual(["CRONK-1"]);

    // A Run finishing frees its slot,
    await finish(first.id);
    expect(started()).toEqual(["CRONK-1", "CRONK-3"]);
    // and so does one failing,
    const [highRun] = await ok("GET", `/api/tickets/${high.id}/runs`, ada);
    await cronk.runner.endWithoutFinishing(highRun.id);
    expect(started()).toEqual(["CRONK-1", "CRONK-3", "CRONK-4"]);
    // and the lowest Priority waits for the last.
    await finish(laterHigh.id);
    expect(started()).toEqual(["CRONK-1", "CRONK-3", "CRONK-4", "CRONK-2"]);
  });

  test("a Run moving its Ticket on to another Step's Status queues behind waiting Tickets of higher Priority", async () => {
    const { ada, project, runner, ticket, status, delegateToTriage, finish, agent } = await adaWithAgent();
    await ok("PATCH", `/api/runners/${runner.id}`, ada, { limit: 1 });
    const moving = await ticket("Moving on");
    const urgent = await ticket("Urgent");
    await ok("PATCH", `/api/tickets/${urgent.id}`, ada, { priority: "urgent" });
    cronk.clock.advance(1000);
    await ok("PATCH", `/api/tickets/${moving.id}`, ada, { delegateId: agent.id, statusId: status("Investigate") });
    await delegateToTriage(urgent.id);

    await finish(moving.id, undefined, "done");

    expect(cronk.runner.starts.map((s) => s.ticket.key)).toEqual(["CRONK-1", "CRONK-2"]);
    expect(await board(project.id, ada)).toEqual({
      "CRONK-1": { run: "finished", waiting: "runnerSlot" },
      "CRONK-2": { run: "running", waiting: null },
    });
  });

  test("a Run its Runner refuses to start passes its slot straight on", async () => {
    const { ada, project, runner, ticket, delegateToTriage, finish } = await adaWithAgent();
    await ok("PATCH", `/api/runners/${runner.id}`, ada, { limit: 1 });
    const tickets = [await ticket("First"), await ticket("Second"), await ticket("Third")];
    for (const t of tickets) await delegateToTriage(t.id);
    cronk.runner.refuseNext({ kind: "unavailable", message: "Down for maintenance." });

    await finish(tickets[0].id);

    expect(cronk.runner.starts.map((s) => s.ticket.key)).toEqual(["CRONK-1", "CRONK-2", "CRONK-3"]);
    expect(await board(project.id, ada)).toEqual({
      "CRONK-1": { run: "finished", waiting: null },
      "CRONK-2": { run: "refused", waiting: null },
      "CRONK-3": { run: "running", waiting: null },
    });
  });
});
