import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

/**
 * Archiving a Project stops its Runs (CRONK-76): an archived Project spends nothing. Its running Runs stop, the
 * Runner's queue passes its Tickets by, and unarchiving starts those still needing a Run, in queue order.
 */

let cronk: StartedCronk;
beforeEach(async () => {
  cronk = await startCronk();
});
afterEach(async () => {
  await cronk?.stop();
});

interface As {
  cookie?: string;
  headers?: Record<string, string>;
}

async function call(method: string, path: string, as: As, body?: unknown) {
  const response = await cronk.request(method, path, { ...as, body });
  return { status: response.status, json: response.status === 204 ? null : await response.json() };
}

async function ok(method: string, path: string, as: As, body?: unknown) {
  const response = await call(method, path, as, body);
  expect(response.status, `${method} ${path}: ${JSON.stringify(response.json)}`).toBeLessThan(300);
  return response.json;
}

/** Ada, the Admin, with Projects CRONK and OTHER on the default board, and her Agent on her fake Runner of limit 1. */
async function withRunner() {
  const { workspace } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const other = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Other", key: "OTHER" });
  const runner = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
  await ok("PATCH", `/api/runners/${runner.id}`, ada, { limit: 1 });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, ada, { runnerId: runner.id });
  /** Creates a Ticket in the Project, delegates it to claude-max and moves it to Triage, a second later than the last. */
  const delegated = async (inProject: { id: string; statuses: { id: string; name: string }[] }, title: string) => {
    cronk.clock.advance(1000);
    const ticket = await ok("POST", `/api/projects/${inProject.id}/tickets`, ada, { title });
    const triage = inProject.statuses.find((s) => s.name === "Triage")!.id;
    cronk.clock.advance(1000);
    return ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: triage });
  };
  const started = () => cronk.runner.starts.map((s) => s.ticket.key);
  return { ada, project, other, agent, delegated, started };
}

/** Each Ticket on the Project's board by key: the state of its latest Run, and what it waits for. */
async function board(projectId: string, as: As) {
  const tickets = await ok("GET", `/api/projects/${projectId}/tickets`, as);
  return Object.fromEntries(
    tickets.map((t: { key: string; lastRun: { state: string } | null; waiting: string | null }) => [
      t.key,
      { run: t.lastRun?.state ?? null, waiting: t.waiting },
    ]),
  );
}

describe("archiving a Project", () => {
  test("stops its running Runs, as Cronk's Change on each Ticket, freeing their slots", async () => {
    const { ada, project, other, delegated, started } = await withRunner();
    const running = await delegated(project, "Running");
    const elsewhere = await delegated(other, "Elsewhere");
    expect(started()).toEqual(["CRONK-1"]);

    await ok("POST", `/api/projects/${project.id}/archive`, ada);

    const [run] = await ok("GET", `/api/tickets/${running.id}/runs`, ada);
    expect(run).toEqual(expect.objectContaining({ state: "stopped", endReason: "ada@example.com archived CRONK, stopping its Runs." }));
    expect(cronk.runner.stops.map((s) => s.runId)).toEqual([run.id]);
    const timeline = await ok("GET", `/api/tickets/${running.id}/timeline`, ada);
    expect(timeline.at(-1)).toEqual(
      expect.objectContaining({
        actor: expect.objectContaining({ kind: "cronk" }),
        field: "runStopped",
        from: { runId: run.id, step: "Triage", agent: expect.objectContaining({ name: "claude-max" }), why: "projectArchived" },
        to: null,
      }),
    );
    // The freed slot goes to another Project's Ticket; the stopped one waits for its Project.
    expect(started()).toEqual(["CRONK-1", "OTHER-1"]);
    expect(await board(project.id, ada)).toEqual({ "CRONK-1": { run: "stopped", waiting: "archived" } });
    expect(await board(other.id, ada)).toEqual({ "OTHER-1": { run: "running", waiting: null } });
    expect(elsewhere.key).toBe("OTHER-1");
  });

  test("its queued Tickets don't start, nor hold back another Project's", async () => {
    const { ada, project, other, delegated, started } = await withRunner();
    const first = await delegated(other, "Running elsewhere");
    const queued = await delegated(project, "Queued, high");
    await ok("PATCH", `/api/tickets/${queued.id}`, ada, { priority: "high" });
    await delegated(other, "Queued elsewhere");
    expect(started()).toEqual(["OTHER-1"]);

    await ok("POST", `/api/projects/${project.id}/archive`, ada);
    expect(await board(project.id, ada)).toEqual({ "CRONK-1": { run: null, waiting: "archived" } });

    // The slot frees: CRONK-1 is ahead by Priority, but its Project is archived, so OTHER-2 gets it.
    const [run] = await ok("GET", `/api/tickets/${first.id}/runs`, ada);
    await cronk.runner.endWithoutFinishing(run.id);
    expect(started()).toEqual(["OTHER-1", "OTHER-2"]);
    expect(await board(project.id, ada)).toEqual({ "CRONK-1": { run: null, waiting: "archived" } });
  });
});

describe("unarchiving a Project", () => {
  test("starts its Tickets that still need a Run, in queue order, the stopped ones included", async () => {
    const { ada, project, delegated, started } = await withRunner();
    await delegated(project, "Running");
    const second = await delegated(project, "Queued");
    const third = await delegated(project, "Queued, high");
    await ok("PATCH", `/api/tickets/${third.id}`, ada, { priority: "high" });
    expect(started()).toEqual(["CRONK-1"]);

    await ok("POST", `/api/projects/${project.id}/archive`, ada);
    expect(started()).toEqual(["CRONK-1"]);
    expect(await board(project.id, ada)).toEqual({
      "CRONK-1": { run: "stopped", waiting: "archived" },
      "CRONK-2": { run: null, waiting: "archived" },
      "CRONK-3": { run: null, waiting: "archived" },
    });

    await ok("POST", `/api/projects/${project.id}/unarchive`, ada);
    // The highest Priority first; then the rest as they entered their Status.
    expect(started()).toEqual(["CRONK-1", "CRONK-3"]);
    expect(await board(project.id, ada)).toEqual({
      "CRONK-1": { run: "stopped", waiting: "runnerSlot" },
      "CRONK-2": { run: null, waiting: "runnerSlot" },
      "CRONK-3": { run: "running", waiting: null },
    });

    const [run] = await ok("GET", `/api/tickets/${third.id}/runs`, ada);
    await cronk.runner.endWithoutFinishing(run.id);
    expect(started()).toEqual(["CRONK-1", "CRONK-3", "CRONK-1"]);
    expect(second.key).toBe("CRONK-2");
  });
});
