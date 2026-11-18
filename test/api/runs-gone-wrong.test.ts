import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";
import { openStream } from "../harness/stream.js";

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

const minutes = (n: number) => n * 60 * 1000;

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
  const inbox = (as: Request = ada) => ok("GET", `/api/workspaces/${workspace.id}/inbox`, as);
  return { workspace, user, ada, project, ticket, runner, agent, asAgent: { headers: { authorization: `Bearer ${secret}` } }, status, inbox };
}

/** Ada's Ticket, delegated to her Agent and in Triage, with its running Run. */
async function runningRun() {
  const setup = await adaWithAgent();
  const { ada, ticket, agent, status } = setup;
  await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });
  const [run] = await runsOf(ticket.id, ada);
  return { ...setup, run };
}

const runsOf = (ticketId: string, as: Request) => ok("GET", `/api/tickets/${ticketId}/runs`, as);
const states = async (ticketId: string, as: Request) =>
  (await runsOf(ticketId, as)).map((r: { step: { name: string }; state: string }) => [r.step.name, r.state]);

describe("failed Runs", () => {
  test("a Run its Runner reports ended without finishing puts its Ticket in the Delegate's Owner's Inbox, where it stays", async () => {
    const { ada, ticket, run, status, inbox } = await runningRun();

    await cronk.runner.endWithoutFinishing(run.id, "The session crashed.");

    expect(await inbox()).toEqual({
      count: 1,
      items: [
        {
          kind: "run",
          ticket: expect.objectContaining({ id: ticket.id, key: "CRONK-1", statusId: status("Triage") }),
          run: {
            id: run.id,
            state: "failed",
            step: { statusId: status("Triage"), name: "Triage" },
            endReason: "The session crashed.",
          },
        },
      ],
    });
    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).statusId).toBe(status("Triage"));
  });
});

describe("Runs that couldn't start", () => {
  test("a Runner refusing to start a Run puts its Ticket in the Inbox with the reason, and nobody else's", async () => {
    const { workspace, ada, ticket, agent, status, inbox } = await adaWithAgent();
    const bea = await addMember(cronk, ada.cookie, workspace.id, "bea@example.com");
    cronk.runner.refuseNext({ kind: "credentials_rejected", message: "The trigger's token was rejected." });

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });

    const { items } = await inbox();
    expect(items).toEqual([
      expect.objectContaining({
        kind: "run",
        run: expect.objectContaining({ state: "refused", endReason: "The trigger's token was rejected." }),
      }),
    ]);
    expect(await inbox({ cookie: bea.cookie })).toEqual({ count: 0, items: [] });
  });

  test("moving the Ticket on takes it out of the Inbox", async () => {
    const { ada, ticket, agent, status, inbox } = await adaWithAgent();
    cronk.runner.refuseNext({ kind: "not_configured", message: "No trigger for haiku." });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });
    expect((await inbox()).count).toBe(1);

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Ready") });

    expect(await inbox()).toEqual({ count: 0, items: [] });
  });
});

describe("rate limits", () => {
  test("a Runner that is rate limited leaves the Ticket waiting, not couldn't-start, and out of the Inbox", async () => {
    const { ada, ticket, agent, status, inbox } = await adaWithAgent();
    cronk.runner.refuseNext({ kind: "rate_limited", message: "Too many fires.", retryAt: new Date("2026-01-01T10:00:00Z") });

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });

    expect(cronk.runner.starts).toHaveLength(1);
    expect(await runsOf(ticket.id, ada)).toEqual([]);
    expect(await ok("GET", `/api/tickets/${ticket.id}`, ada)).toEqual(
      expect.objectContaining({ lastRun: null, waiting: "runnerPaused" }),
    );
    expect(await inbox()).toEqual({ count: 0, items: [] });
  });

  test("the rate-limited Ticket gets a Run once its Runner's pause has passed, not when another Run ends before", async () => {
    const { ada, project, agent, asAgent, status } = await adaWithAgent();
    const first = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "First" });
    const second = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Second" });
    await ok("PATCH", `/api/tickets/${first.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });
    cronk.runner.refuseNext({ kind: "rate_limited", message: "Too many fires.", retryAt: new Date("2026-01-01T10:00:00Z") });
    await ok("PATCH", `/api/tickets/${second.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });
    expect(cronk.runner.starts.map((s) => s.ticket.key)).toEqual(["CRONK-2", "CRONK-3"]);

    const [firstRun] = await runsOf(first.id, ada);
    await ok("POST", `/api/runs/${firstRun.id}/finish`, asAgent, { outcome: "ready" });
    expect(cronk.runner.starts.map((s) => s.ticket.key)).toEqual(["CRONK-2", "CRONK-3"]);

    cronk.clock.advance(minutes(60));
    await cronk.resumePausedRunners();

    expect(cronk.runner.starts.map((s) => s.ticket.key)).toEqual(["CRONK-2", "CRONK-3", "CRONK-3"]);
    expect(await states(second.id, ada)).toEqual([["Triage", "running"]]);
    expect((await ok("GET", `/api/tickets/${second.id}`, ada)).waiting).toBeNull();
  });
});

describe("Retry", () => {
  test("starts a fresh Run of the same Step, taking the Ticket out of the Inbox", async () => {
    const { ada, ticket, run, status, inbox } = await runningRun();
    await cronk.runner.endWithoutFinishing(run.id, "The session crashed.");

    const retried = await call("POST", `/api/tickets/${ticket.id}/retry`, ada);

    expect(retried.status).toBe(200);
    const [, fresh] = await runsOf(ticket.id, ada);
    expect(fresh).toEqual(
      expect.objectContaining({ step: { statusId: status("Triage"), name: "Triage" }, model: "haiku", state: "running" }),
    );
    expect(retried.json).toEqual(
      expect.objectContaining({ id: ticket.id, lastRun: { id: fresh.id, state: "running" }, waiting: null }),
    );
    expect(await states(ticket.id, ada)).toEqual([
      ["Triage", "failed"],
      ["Triage", "running"],
    ]);
    expect(cronk.runner.starts.map((s) => s.runId)).toEqual([run.id, fresh.id]);
    expect(await inbox()).toEqual({ count: 0, items: [] });
  });

  test("waits like any Ticket while its Runner is full, out of the Inbox, and starts when a slot frees", async () => {
    const { ada, project, ticket, run, runner, agent, asAgent, status, inbox } = await runningRun();
    await cronk.runner.endWithoutFinishing(run.id);
    await ok("PATCH", `/api/runners/${runner.id}`, ada, { limit: 1 });
    const other = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Holds the slot" });
    await ok("PATCH", `/api/tickets/${other.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });

    const retried = await ok("POST", `/api/tickets/${ticket.id}/retry`, ada);

    expect(retried).toEqual(expect.objectContaining({ lastRun: { id: run.id, state: "failed" }, waiting: "runnerSlot" }));
    expect(await inbox()).toEqual({ count: 0, items: [] });

    const [otherRun] = await runsOf(other.id, ada);
    await ok("POST", `/api/runs/${otherRun.id}/finish`, asAgent, { outcome: "ready" });
    expect(await states(ticket.id, ada)).toEqual([
      ["Triage", "failed"],
      ["Triage", "running"],
    ]);
  });

  test("works for a Run that couldn't start", async () => {
    const { ada, ticket, agent, status } = await adaWithAgent();
    cronk.runner.refuseNext({ kind: "not_configured", message: "No trigger for haiku." });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });

    await ok("POST", `/api/tickets/${ticket.id}/retry`, ada);

    expect(await states(ticket.id, ada)).toEqual([
      ["Triage", "refused"],
      ["Triage", "running"],
    ]);
  });

  test("is refused while a Run is running, after one finished, and for Agents", async () => {
    const { ada, ticket, run, asAgent } = await runningRun();

    const whileRunning = await call("POST", `/api/tickets/${ticket.id}/retry`, ada);
    expect(whileRunning.status).toBe(409);
    expect(whileRunning.json.error.code).toBe("nothing_to_retry");

    await cronk.runner.endWithoutFinishing(run.id);
    expect((await call("POST", `/api/tickets/${ticket.id}/retry`, asAgent)).status).toBe(403);

    await ok("POST", `/api/tickets/${ticket.id}/retry`, ada);
    const [, second] = await runsOf(ticket.id, ada);
    await ok("POST", `/api/runs/${second.id}/finish`, asAgent, { outcome: "ready" });
    expect((await call("POST", `/api/tickets/${ticket.id}/retry`, ada)).json.error.code).toBe("nothing_to_retry");
    expect(cronk.runner.starts).toHaveLength(2);
  });

  test("only the Delegate's Owner retries, since the Run spends their credentials", async () => {
    const { workspace, ada, ticket, run } = await runningRun();
    const bea = await addMember(cronk, ada.cookie, workspace.id, "bea@example.com");
    await cronk.runner.endWithoutFinishing(run.id);

    const byBea = await call("POST", `/api/tickets/${ticket.id}/retry`, { cookie: bea.cookie });

    expect(byBea.status).toBe(403);
    expect(byBea.json.error).toEqual({
      code: "not_delegates_owner",
      message: "Only ada@example.com, the Owner of claude-max, retries CRONK-1: its Runs spend their credentials.",
    });
    expect(cronk.runner.starts).toHaveLength(1);
  });

  test("is refused once the Ticket left the Status of the Run that went wrong", async () => {
    const { ada, ticket, run, status } = await runningRun();
    await cronk.runner.endWithoutFinishing(run.id);
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Ready") });

    const response = await call("POST", `/api/tickets/${ticket.id}/retry`, ada);

    expect(response.status).toBe(409);
    expect(response.json.error.code).toBe("nothing_to_retry");
    expect(cronk.runner.starts).toHaveLength(1);
  });
});

describe("lost Runs", () => {
  test("a Run with no calls for 30 minutes is lost and waits in the Inbox; until then it keeps running", async () => {
    const { ada, ticket, run, inbox } = await runningRun();

    cronk.clock.advance(minutes(29));
    await cronk.checkForLostRuns();
    expect((await ok("GET", `/api/runs/${run.id}`, ada)).state).toBe("running");

    cronk.clock.advance(minutes(1));
    await cronk.checkForLostRuns();

    expect(await ok("GET", `/api/runs/${run.id}`, ada)).toEqual(
      expect.objectContaining({ state: "lost", endReason: "No call named the Run or CRONK-1 for 30 minutes.", endedAt: "2026-01-01T09:30:00.000Z" }),
    );
    // Its session may yet be alive, so Cronk asks the Runner to stop it, keeping a Retry from running beside it.
    expect(cronk.runner.stops).toEqual([
      { runId: run.id, reference: { sessionId: "session_1", url: "https://claude.ai/code/session_1" } },
    ]);
    expect((await inbox()).items).toEqual([
      expect.objectContaining({ kind: "run", ticket: expect.objectContaining({ id: ticket.id }), run: expect.objectContaining({ state: "lost" }) }),
    ]);
  });

  test("each call its Agent makes naming the Run or its Ticket keeps it alive for another 30 minutes", async () => {
    const { workspace, ada, project, ticket, run, asAgent } = await runningRun();
    const other = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Another" });
    const alive = async (after: number) => {
      cronk.clock.advance(minutes(after));
      await cronk.checkForLostRuns();
      return (await ok("GET", `/api/runs/${run.id}`, ada)).state;
    };

    cronk.clock.advance(minutes(20));
    await ok("GET", `/api/tickets/${ticket.id}`, asAgent);
    expect(await alive(29)).toBe("running");
    await ok("GET", `/api/workspaces/${workspace.id}/tickets/CRONK-1`, asAgent);
    expect(await alive(29)).toBe("running");
    await ok("GET", `/api/runs/${run.id}/brief`, asAgent);
    expect(await alive(29)).toBe("running");

    // Neither a User's calls nor the Agent's calls about other Tickets keep it alive.
    await ok("GET", `/api/tickets/${ticket.id}`, ada);
    await ok("GET", `/api/tickets/${other.id}`, asAgent);
    expect(await alive(1)).toBe("lost");
  });

  test("Admins set the lost-Run threshold per Workspace; other members only read it", async () => {
    const { workspace, ada, run } = await runningRun();
    const settings = `/api/workspaces/${workspace.id}/settings`;
    const bea = await addMember(cronk, ada.cookie, workspace.id, "bea@example.com");
    expect(await ok("GET", settings, { cookie: bea.cookie })).toEqual({ lostRunMinutes: 30 });

    expect((await call("PATCH", settings, { cookie: bea.cookie }, { lostRunMinutes: 10 })).status).toBe(403);
    expect((await call("PATCH", settings, ada, { lostRunMinutes: 0 })).status).toBe(400);
    expect(await ok("PATCH", settings, ada, { lostRunMinutes: 10 })).toEqual({ lostRunMinutes: 10 });

    cronk.clock.advance(minutes(10));
    await cronk.checkForLostRuns();
    expect(await ok("GET", `/api/runs/${run.id}`, ada)).toEqual(
      expect.objectContaining({ state: "lost", endReason: "No call named the Run or CRONK-1 for 10 minutes." }),
    );
  });

  test("another Workspace's threshold leaves this one's Runs alone", async () => {
    const { ada, run } = await runningRun();
    const elsewhere = await ok("POST", "/api/workspaces", ada, { name: "Elsewhere" });
    await ok("PATCH", `/api/workspaces/${elsewhere.id}/settings`, ada, { lostRunMinutes: 5 });

    cronk.clock.advance(minutes(10));
    await cronk.checkForLostRuns();

    expect((await ok("GET", `/api/runs/${run.id}`, ada)).state).toBe("running");
  });
});

describe("stopped Runs", () => {
  test("a User moving the Ticket by hand stops its running Run, and Cronk tells the Runner", async () => {
    const { ada, ticket, run, status, inbox } = await runningRun();

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Ready") });

    expect(await ok("GET", `/api/runs/${run.id}`, ada)).toEqual(
      expect.objectContaining({
        state: "stopped",
        endReason: "ada@example.com moved CRONK-1 to Ready.",
        endedAt: "2026-01-01T09:00:00.000Z",
      }),
    );
    expect(cronk.runner.stops).toEqual([
      { runId: run.id, reference: { sessionId: "session_1", url: "https://claude.ai/code/session_1" } },
    ]);
    // A stopped Run was the User's own doing: nothing waits in the Inbox.
    expect(await inbox()).toEqual({ count: 0, items: [] });
  });

  test("moving it into another Step's Status stops the Run and starts one of that Step", async () => {
    const { ada, ticket, status } = await runningRun();

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Investigate") });

    expect(await states(ticket.id, ada)).toEqual([
      ["Triage", "stopped"],
      ["Investigate", "running"],
    ]);
  });

  test("undelegating the Ticket stops its Run", async () => {
    const { ada, ticket, run } = await runningRun();

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: null });

    expect(await ok("GET", `/api/runs/${run.id}`, ada)).toEqual(
      expect.objectContaining({ state: "stopped", endReason: "ada@example.com undelegated CRONK-1." }),
    );
  });

  test("changing its Delegate stops the Run, and the new Delegate gets one of the same Step", async () => {
    const { workspace, ada, ticket, run, runner } = await runningRun();
    const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-api" });
    const other = await ok("PATCH", `/api/agents/${created.id}`, ada, { runnerId: runner.id });

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: other.id });

    expect(await ok("GET", `/api/runs/${run.id}`, ada)).toEqual(
      expect.objectContaining({ state: "stopped", endReason: "ada@example.com delegated CRONK-1 to claude-api." }),
    );
    const runs = await runsOf(ticket.id, ada);
    expect(runs.map((r: { agent: { name: string }; state: string }) => [r.agent.name, r.state])).toEqual([
      ["claude-max", "stopped"],
      ["claude-api", "running"],
    ]);
  });

  test("editing anything else leaves the Run running", async () => {
    const { ada, ticket, run } = await runningRun();

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { title: "Make it so, now", priority: "high" });

    expect((await ok("GET", `/api/runs/${run.id}`, ada)).state).toBe("running");
    expect(cronk.runner.stops).toEqual([]);
  });

  test("the stopped Run's later calls are refused, telling its Agent to stop; Users still read it", async () => {
    const { ada, ticket, run, asAgent, status } = await runningRun();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Ready") });

    for (const [method, path, body] of [
      ["POST", `/api/runs/${run.id}/finish`, { outcome: "ready" }],
      ["GET", `/api/runs/${run.id}`, undefined],
      ["GET", `/api/runs/${run.id}/brief`, undefined],
    ] as const) {
      const response = await call(method, path, asAgent, body);
      expect(response.status, path).toBe(409);
      expect(response.json.error).toEqual({
        code: "run_stopped",
        message: "ada@example.com moved CRONK-1 to Ready, which stopped this Run.",
        rule: "A User moving, undelegating or re-delegating a Ticket stops its running Run, and Cronk refuses the stopped Run's calls.",
        advice: "Stop working on CRONK-1 and end your session. A User decides what happens to it next.",
      });
    }
    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).statusId).toBe(status("Ready"));
    expect((await ok("GET", `/api/runs/${run.id}`, ada)).state).toBe("stopped");
  });
});

describe("removing an Agent", () => {
  test("undelegates each of its Tickets, recording the Change as its Owner's, and keeps their Assignee", async () => {
    const { user, ada, project, ticket, agent } = await adaWithAgent();
    const other = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Make it so too" });
    for (const t of [ticket, other]) await ok("PATCH", `/api/tickets/${t.id}`, ada, { delegateId: agent.id });

    await ok("DELETE", `/api/agents/${agent.id}`, ada);

    for (const t of [ticket, other]) {
      expect(await ok("GET", `/api/tickets/${t.id}`, ada)).toEqual(
        expect.objectContaining({ assigneeId: user.id, delegateId: null }),
      );
      const timeline = await ok("GET", `/api/tickets/${t.id}/timeline`, ada);
      expect(timeline.at(-1)).toEqual(
        expect.objectContaining({
          field: "delegate",
          from: { id: agent.id, name: "claude-max" },
          to: null,
          actor: expect.objectContaining({ kind: "user", id: user.id }),
        }),
      );
    }
  });

  test("stops its running Runs, tells their Runner, and refuses their later calls", async () => {
    const { ada, ticket, run, asAgent, inbox, status } = await runningRun();

    await ok("DELETE", `/api/agents/${run.agent.id}`, ada);

    expect(await ok("GET", `/api/runs/${run.id}`, ada)).toEqual(
      expect.objectContaining({
        state: "stopped",
        endReason: "ada@example.com removed claude-max.",
        endedAt: "2026-01-01T09:00:00.000Z",
      }),
    );
    expect(cronk.runner.stops).toEqual([
      { runId: run.id, reference: { sessionId: "session_1", url: "https://claude.ai/code/session_1" } },
    ]);
    const finish = await call("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "ready" });
    expect(finish.status).toBe(401);
    expect(finish.json.error.code).toBe("invalid_token");
    // The Ticket stays where it was, undelegated, for its Assignee to decide on.
    expect(await ok("GET", `/api/tickets/${ticket.id}`, ada)).toEqual(
      expect.objectContaining({ statusId: status("Triage"), delegateId: null }),
    );
    // Removing it was its Owner's own doing: nothing waits in the Inbox.
    expect(await inbox()).toEqual({ count: 0, items: [] });
  });

  test("its Tickets start no Run when moved into a Status with a Step afterwards", async () => {
    const { ada, project, ticket, agent, status } = await adaWithAgent();
    const other = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Make it so too" });
    for (const t of [ticket, other]) await ok("PATCH", `/api/tickets/${t.id}`, ada, { delegateId: agent.id });

    await ok("DELETE", `/api/agents/${agent.id}`, ada);
    const moved = await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Triage") });

    expect(moved).toEqual(expect.objectContaining({ delegateId: null, waiting: null }));
    expect(await runsOf(ticket.id, ada)).toEqual([]);
    expect((await ok("GET", `/api/tickets/${other.id}`, ada)).delegateId).toBeNull();
    expect(cronk.runner.starts).toEqual([]);
  });

  test("a Ticket delegated to it while it is being removed ends up undelegated", async () => {
    const { ada, project, agent, status } = await adaWithAgent();
    // With no Runner its Runs are refused at once, so nothing runs on after the test ends.
    await ok("PATCH", `/api/agents/${agent.id}`, ada, { runnerId: null });
    const tickets = [];
    for (let i = 0; i < 20; i++) {
      tickets.push(await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: `Race ${i}` }));
    }

    await Promise.all([
      ...tickets.map((t) => call("PATCH", `/api/tickets/${t.id}`, ada, { delegateId: agent.id, statusId: status("Triage") })),
      ok("DELETE", `/api/agents/${agent.id}`, ada),
    ]);

    for (const t of tickets) {
      expect((await ok("GET", `/api/tickets/${t.id}`, ada)).delegateId).toBeNull();
    }
  });

  test("a Sub-Ticket created while it is being removed doesn't inherit it", async () => {
    const { ada, project, ticket, agent } = await adaWithAgent();
    // With no Runner its Runs are refused at once, so nothing runs on after the test ends.
    await ok("PATCH", `/api/agents/${agent.id}`, ada, { runnerId: null });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id });

    const create = (i: number) => call("POST", `/api/projects/${project.id}/tickets`, ada, { title: `Part ${i}`, parentId: ticket.id });
    const created = await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => create(i)),
      ok("DELETE", `/api/agents/${agent.id}`, ada).then(() => null),
      ...Array.from({ length: 10 }, (_, i) => create(10 + i)),
    ]);

    for (const { json } of created.filter((c) => c !== null)) {
      expect((await ok("GET", `/api/tickets/${json.id}`, ada)).delegateId).toBeNull();
    }
  });

  test("a Ticket waiting for its Runner's slot stops waiting, and the slot goes to the next Agent's Ticket", async () => {
    const { workspace, ada, project, ticket, agent, runner, status } = await runningRun();
    await ok("PATCH", `/api/runners/${runner.id}`, ada, { limit: 1 });
    const second = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-api" });
    await ok("PATCH", `/api/agents/${second.id}`, ada, { runnerId: runner.id });
    const waitingOfRemoved = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Wait for it" });
    await ok("PATCH", `/api/tickets/${waitingOfRemoved.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });
    const waitingOfOther = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Me next" });
    await ok("PATCH", `/api/tickets/${waitingOfOther.id}`, ada, { delegateId: second.id, statusId: status("Triage") });

    await ok("DELETE", `/api/agents/${agent.id}`, ada);

    expect((await ok("GET", `/api/tickets/${waitingOfRemoved.id}`, ada)).waiting).toBeNull();
    expect(await runsOf(waitingOfRemoved.id, ada)).toEqual([]);
    await expect.poll(async () => await states(waitingOfOther.id, ada)).toEqual([["Triage", "running"]]);
    expect(await states(ticket.id, ada)).toEqual([["Triage", "stopped"]]);
  });
});

describe("nothing retries by itself", () => {
  test("after a Run fails, is lost or couldn't start, no new Run starts until a User acts", async () => {
    const { ada, project, agent, status, inbox } = await adaWithAgent();
    const ticket = (title: string) => ok("POST", `/api/projects/${project.id}/tickets`, ada, { title });
    const [failed, lost, refused] = [await ticket("Fails"), await ticket("Goes silent"), await ticket("Can't start")];
    for (const t of [failed, lost, refused]) {
      if (t === refused) cronk.runner.refuseNext({ kind: "credentials_rejected", message: "Rejected." });
      await ok("PATCH", `/api/tickets/${t.id}`, ada, { delegateId: agent.id, statusId: status("Implement") });
    }
    const [failedRun] = await runsOf(failed.id, ada);
    await cronk.runner.endWithoutFinishing(failedRun.id);
    cronk.clock.advance(minutes(30));
    await cronk.checkForLostRuns();
    const startsSoFar = cronk.runner.starts.length;

    // Time passes, checks run, and Users edit everything but Status and Delegate.
    for (let hour = 0; hour < 3; hour++) {
      cronk.clock.advance(minutes(60));
      await cronk.checkForLostRuns();
    }
    for (const t of [failed, lost, refused]) {
      await ok("PATCH", `/api/tickets/${t.id}`, ada, { priority: "urgent", labels: ["again"], title: `${t.title}!` });
    }

    expect(cronk.runner.starts).toHaveLength(startsSoFar);
    expect(await states(failed.id, ada)).toEqual([["Implement", "failed"]]);
    expect(await states(lost.id, ada)).toEqual([["Implement", "lost"]]);
    expect(await states(refused.id, ada)).toEqual([["Implement", "refused"]]);
    expect((await inbox()).count).toBe(3);
  });
});

describe("live", () => {
  test("a Run becoming lost, and a Retry, each tell the Workspace's streams its Ticket changed", async () => {
    const { workspace, ada, project, ticket } = await runningRun();
    const stream = await openStream(cronk, ada.cookie, workspace.id);
    const changed = { type: "ticket.changed", data: { projectId: project.id, ticketId: ticket.id } };

    cronk.clock.advance(minutes(30));
    await cronk.checkForLostRuns();
    expect(await stream.next()).toEqual(changed);

    await ok("POST", `/api/tickets/${ticket.id}/retry`, ada);
    expect(await stream.next()).toEqual(changed);
    stream.close();
  });
});
