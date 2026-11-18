import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";
import { openStream, type OpenStream } from "../harness/stream.js";

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

describe("blocked Tickets", () => {
  test("a blocked Ticket gets no Run, and gets one by itself once its blocker is finished", async () => {
    const { ada, project, status, ticket, delegateToTriage } = await adaWithAgent();
    const blocker = await ticket("Blocker");
    const blocked = await ticket("Blocked");
    await ok("POST", `/api/tickets/${blocked.id}/relations`, ada, { kind: "blockedBy", ticketId: blocker.id });

    await delegateToTriage(blocked.id);
    expect(await board(project.id, ada)).toEqual({
      "CRONK-1": { run: null, waiting: null },
      "CRONK-2": { run: null, waiting: "blocked" },
    });

    await ok("PATCH", `/api/tickets/${blocker.id}`, ada, { statusId: status("Done") });

    expect(cronk.runner.starts.map((s) => s.ticket.key)).toEqual(["CRONK-2"]);
    expect(await board(project.id, ada)).toEqual({
      "CRONK-1": { run: null, waiting: null },
      "CRONK-2": { run: "running", waiting: null },
    });
  });

  test("a blocker finished by its Run's Outcome, or Canceled, or no longer blocking, starts what it blocked", async () => {
    const { ada, agent, project, status, ticket, delegateToTriage, finish } = await adaWithAgent();
    const [finishedByRun, canceled, unlinked] = [await ticket("A"), await ticket("B"), await ticket("C")];
    const blocked = [await ticket("D"), await ticket("E"), await ticket("F")];
    const relations = [];
    for (const [i, blocker] of [finishedByRun, canceled, unlinked].entries()) {
      relations.push(await ok("POST", `/api/tickets/${blocker.id}/relations`, ada, { kind: "blocks", ticketId: blocked[i].id }));
    }
    for (const t of blocked) await delegateToTriage(t.id);
    expect(cronk.runner.starts).toEqual([]);

    // A Run whose Outcome moves its Ticket to a Done Status needs Autonomous Delegation, which no Ticket has yet;
    // a Ticket an Outcome moves to Review is still unfinished.
    await ok("PATCH", `/api/tickets/${finishedByRun.id}`, ada, { delegateId: agent.id, statusId: status("Code review") });
    await finish(finishedByRun.id, undefined, "approve");
    expect(cronk.runner.starts.map((s) => s.ticket.key)).toEqual(["CRONK-1"]);
    await ok("PATCH", `/api/tickets/${finishedByRun.id}`, ada, { statusId: status("Done") });
    expect(cronk.runner.starts.map((s) => s.ticket.key)).toEqual(["CRONK-1", "CRONK-4"]);

    await ok("PATCH", `/api/tickets/${canceled.id}`, ada, { statusId: status("Canceled") });
    expect(cronk.runner.starts.map((s) => s.ticket.key)).toEqual(["CRONK-1", "CRONK-4", "CRONK-5"]);

    // Unblocked while its Runner is full, it waits for a slot instead.
    await ok("DELETE", `/api/tickets/${unlinked.id}/relations/${relations[2].id}`, ada);
    expect((await board(project.id, ada))["CRONK-6"]).toEqual({ run: null, waiting: "runnerSlot" });
    await finish(blocked[0].id);
    expect(cronk.runner.starts.map((s) => s.ticket.key)).toEqual(["CRONK-1", "CRONK-4", "CRONK-5", "CRONK-6"]);
  });

  test("a blocked Ticket holds no Runner slot: Tickets behind it in the queue start", async () => {
    const { ada, project, runner, ticket, delegateToTriage } = await adaWithAgent();
    await ok("PATCH", `/api/runners/${runner.id}`, ada, { limit: 1 });
    const blocker = await ticket("Blocker");
    const urgent = await ticket("Urgent, blocked");
    const low = await ticket("Low");
    await ok("PATCH", `/api/tickets/${urgent.id}`, ada, { priority: "urgent" });
    await ok("POST", `/api/tickets/${urgent.id}/relations`, ada, { kind: "blockedBy", ticketId: blocker.id });

    await delegateToTriage(urgent.id);
    await delegateToTriage(low.id);

    expect(await board(project.id, ada)).toEqual({
      "CRONK-1": { run: null, waiting: null },
      "CRONK-2": { run: null, waiting: "blocked" },
      "CRONK-3": { run: "running", waiting: null },
    });
  });
});

describe("parents", () => {
  test("a parent gets no Run while a Sub-Ticket is unfinished, and gets one when the last is finished", async () => {
    const { ada, project, status, ticket, delegateToTriage } = await adaWithAgent();
    const parent = await ticket("Parent");
    const [first, second] = [await ticket("First part"), await ticket("Second part")];
    for (const sub of [first, second]) await ok("PATCH", `/api/tickets/${sub.id}`, ada, { parentId: parent.id });

    await delegateToTriage(parent.id);
    expect((await board(project.id, ada))["CRONK-1"]).toEqual({ run: null, waiting: "blocked" });

    await ok("PATCH", `/api/tickets/${first.id}`, ada, { statusId: status("Done") });
    expect(cronk.runner.starts).toEqual([]);
    await ok("PATCH", `/api/tickets/${second.id}`, ada, { statusId: status("Done") });

    expect(cronk.runner.starts.map((s) => s.ticket.key)).toEqual(["CRONK-1"]);
    expect((await board(project.id, ada))["CRONK-1"]).toEqual({ run: "running", waiting: null });
  });

  test("taking its last unfinished Sub-Ticket away starts the parent", async () => {
    const { ada, ticket, delegateToTriage } = await adaWithAgent();
    const parent = await ticket("Parent");
    const sub = await ticket("Part");
    await ok("PATCH", `/api/tickets/${sub.id}`, ada, { parentId: parent.id });
    await delegateToTriage(parent.id);

    await ok("PATCH", `/api/tickets/${sub.id}`, ada, { parentId: null });

    expect(cronk.runner.starts.map((s) => s.ticket.key)).toEqual(["CRONK-1"]);
  });
});

describe("limits per Runner", () => {
  test("two Users' Runners don't share slots", async () => {
    const { workspace, ada, project, runner, ticket, delegateToTriage } = await adaWithAgent();
    await ok("PATCH", `/api/runners/${runner.id}`, ada, { limit: 1 });
    const bob = await addMember(cronk, ada.cookie!, workspace.id, "bob@example.com");
    const asBob = { cookie: bob.cookie };
    const bobsRunner = await ok("POST", "/api/runners", asBob, { name: "Bob's", kind: "fake" });
    await ok("PATCH", `/api/runners/${bobsRunner.id}`, asBob, { limit: 1 });
    const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, asBob, { name: "bob-bot" });
    const bobsAgent = await ok("PATCH", `/api/agents/${created.id}`, asBob, { runnerId: bobsRunner.id });

    await delegateToTriage((await ticket("Ada's first")).id);
    await delegateToTriage((await ticket("Ada's second")).id);
    await delegateToTriage((await ticket("Bob's")).id, asBob, bobsAgent.id);

    expect(cronk.runner.starts.map((s) => [s.ticket.key, s.runner.name])).toEqual([
      ["CRONK-1", "Fake"],
      ["CRONK-3", "Bob's"],
    ]);
    expect(await board(project.id, ada)).toEqual({
      "CRONK-1": { run: "running", waiting: null },
      "CRONK-2": { run: null, waiting: "runnerSlot" },
      "CRONK-3": { run: "running", waiting: null },
    });
  });
});

describe("an Agent changing Runners", () => {
  test("its waiting Tickets take the free slots of the Runner it now uses", async () => {
    const { ada, agent, runner, ticket, delegateToTriage } = await adaWithAgent();
    await ok("PATCH", `/api/runners/${runner.id}`, ada, { limit: 1 });
    await delegateToTriage((await ticket("First")).id);
    await delegateToTriage((await ticket("Second")).id);
    const spare = await ok("POST", "/api/runners", ada, { name: "Spare", kind: "fake" });

    await ok("PATCH", `/api/agents/${agent.id}`, ada, { runnerId: spare.id });

    expect(cronk.runner.starts.map((s) => [s.ticket.key, s.runner.name])).toEqual([
      ["CRONK-1", "Fake"],
      ["CRONK-2", "Spare"],
    ]);
  });
});

describe("waiting live", () => {
  /** The Tickets the stream says changed, until it goes quiet. */
  async function changedTickets(stream: OpenStream) {
    const changed = new Set<unknown>();
    for (;;) {
      try {
        const event = await stream.next(300);
        if (event.type === "ticket.changed") changed.add(event.data.ticketId);
      } catch {
        return changed;
      }
    }
  }

  test("a Ticket starting to wait, and its wait ending, each tell the Workspace's streams its card changed", async () => {
    const { workspace, ada, runner, status, ticket, delegateToTriage, finish } = await adaWithAgent();
    await ok("PATCH", `/api/runners/${runner.id}`, ada, { limit: 1 });
    const [running, waiting, blocker, blocked] = [await ticket("A"), await ticket("B"), await ticket("C"), await ticket("D")];
    await ok("POST", `/api/tickets/${blocked.id}/relations`, ada, { kind: "blockedBy", ticketId: blocker.id });
    await delegateToTriage(running.id);
    const stream = await openStream(cronk, ada.cookie!, workspace.id);

    await delegateToTriage(waiting.id);
    await delegateToTriage(blocked.id);
    expect(await changedTickets(stream)).toEqual(new Set([waiting.id, blocked.id]));

    // The blocker finishing changes the blocked card, from blocked to waiting for a slot behind B.
    await ok("PATCH", `/api/tickets/${blocker.id}`, ada, { statusId: status("Done") });
    expect(await changedTickets(stream)).toEqual(new Set([blocker.id, blocked.id]));

    await finish(running.id);
    expect(await changedTickets(stream)).toEqual(new Set([running.id, waiting.id]));
    stream.close();
  });
});
