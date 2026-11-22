import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";
import { openStream, type LiveEvent } from "../harness/stream.js";

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

/** Ada with the Project CRONK on the default board, and a Workspace she can add more Projects to. */
async function ada() {
  const { workspace } = await setUp(cronk);
  const as = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, as, { name: "Cronker", key: "CRONK" });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id as string;
  const ticket = (title: string, projectId: string = project.id) =>
    ok("POST", `/api/projects/${projectId}/tickets`, as, { title });
  const blocks = (blocker: { id: string }, blocked: { id: string }) =>
    ok("POST", `/api/tickets/${blocker.id}/relations`, as, { kind: "blocks", ticketId: blocked.id });
  const listed = async (key: string, projectId: string = project.id) => {
    const tickets = await ok("GET", `/api/projects/${projectId}/tickets`, as);
    return tickets.find((t: { key: string }) => t.key === key);
  };
  return { workspace, ada: as, project, status, ticket, blocks, listed };
}

/** The Tickets a stream says changed, from its next event until it goes quiet. */
async function changedUntilQuiet(stream: { next(timeoutMs?: number): Promise<LiveEvent> }) {
  const events: LiveEvent[] = [await stream.next()];
  for (;;) {
    try {
      events.push(await stream.next(300));
    } catch {
      return events.filter((e) => e.type === "ticket.changed").map((e) => e.data);
    }
  }
}

describe("the Tickets list's blockers", () => {
  test("each Ticket lists the unfinished Tickets blocking it by id, key and title; an unblocked one lists none", async () => {
    const { workspace, ada: as, ticket, blocks, listed } = await ada();
    const signInTicket = await ticket("Sign in");
    const board = await ticket("Board");
    await ticket("Unblocked");
    const website = await ok("POST", `/api/workspaces/${workspace.id}/projects`, as, { name: "Website", key: "WEB" });
    const landing = await ticket("Landing page", website.id);
    await blocks(signInTicket, board);
    await blocks(landing, board);

    expect((await listed("CRONK-2")).blockedBy).toEqual([
      { id: signInTicket.id, projectId: signInTicket.projectId, key: "CRONK-1", title: "Sign in" },
      { id: landing.id, projectId: website.id, key: "WEB-1", title: "Landing page" },
    ]);
    expect((await listed("CRONK-1")).blockedBy).toEqual([]);
    expect((await listed("CRONK-3")).blockedBy).toEqual([]);
  });

  test("a blocker moved to a Done or Canceled Status stops counting, and counts again once moved back", async () => {
    const { ada: as, status, ticket, blocks, listed } = await ada();
    const shipped = await ticket("Shipped");
    const dropped = await ticket("Dropped");
    const board = await ticket("Board");
    await blocks(shipped, board);
    await blocks(dropped, board);

    await ok("PATCH", `/api/tickets/${shipped.id}`, as, { statusId: status("Done") });
    expect((await listed("CRONK-3")).blockedBy.map((t: { key: string }) => t.key)).toEqual(["CRONK-2"]);
    await ok("PATCH", `/api/tickets/${dropped.id}`, as, { statusId: status("Canceled") });
    expect((await listed("CRONK-3")).blockedBy).toEqual([]);

    await ok("PATCH", `/api/tickets/${shipped.id}`, as, { statusId: status("Implement") });
    expect((await listed("CRONK-3")).blockedBy.map((t: { key: string }) => t.key)).toEqual(["CRONK-1"]);
  });

  test("a blocker a Run completed as Unverified stops counting; Reopening it counts it again", async () => {
    const { workspace, ada: as, status, ticket, blocks, listed } = await ada();
    const runner = await ok("POST", "/api/runners", as, { name: "Fake", kind: "fake" });
    const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, as, { name: "claude-max" });
    const agent = await ok("PATCH", `/api/agents/${created.id}`, as, { runnerId: runner.id });
    const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, as, { name: "cloud", access: "full" });
    const blocker = await ticket("Sign in");
    const board = await ticket("Board");
    await blocks(blocker, board);
    await ok("PATCH", `/api/tickets/${blocker.id}`, as, { autonomousDelegation: true, delegateId: agent.id });
    await ok("PATCH", `/api/tickets/${blocker.id}`, as, { statusId: status("Code review") });
    const [run] = await ok("GET", `/api/tickets/${blocker.id}/runs`, as);

    await ok("POST", `/api/runs/${run.id}/finish`, { headers: { authorization: `Bearer ${secret}` } }, { outcome: "complete" });
    expect(await listed("CRONK-1")).toEqual(expect.objectContaining({ verification: "unverified" }));
    expect((await listed("CRONK-2")).blockedBy).toEqual([]);

    const stream = await openStream(cronk, as.cookie!, workspace.id);
    await ok("POST", `/api/tickets/${blocker.id}/reopen`, as, { comment: "The tests don't pass." });
    expect((await listed("CRONK-2")).blockedBy.map((t: { key: string }) => t.key)).toEqual(["CRONK-1"]);
    expect(await changedUntilQuiet(stream)).toContainEqual({ projectId: board.projectId, ticketId: board.id });
    stream.close();
  });
});

describe("live updates", () => {
  test("a block added or removed, and its blocker finishing, moving back or renamed, tell the blocked Ticket's Project", async () => {
    const { workspace, ada: as, project, status, ticket, blocks } = await ada();
    const website = await ok("POST", `/api/workspaces/${workspace.id}/projects`, as, { name: "Website", key: "WEB" });
    const blocker = await ticket("Sign in");
    const landing = await ticket("Landing page", website.id);
    const stream = await openStream(cronk, as.cookie!, workspace.id);
    const changedTickets = () => changedUntilQuiet(stream);
    const blockerChanged = { projectId: project.id, ticketId: blocker.id };
    const landingChanged = { projectId: website.id, ticketId: landing.id };

    const relation = await blocks(blocker, landing);
    expect(await changedTickets()).toEqual(expect.arrayContaining([blockerChanged, landingChanged]));
    await ok("PATCH", `/api/tickets/${blocker.id}`, as, { statusId: status("Done") });
    expect(await changedTickets()).toEqual(expect.arrayContaining([blockerChanged, landingChanged]));
    await ok("PATCH", `/api/tickets/${blocker.id}`, as, { statusId: status("Backlog") });
    expect(await changedTickets()).toEqual(expect.arrayContaining([blockerChanged, landingChanged]));
    await ok("PATCH", `/api/tickets/${blocker.id}`, as, { title: "Sign in with GitHub" });
    expect(await changedTickets()).toEqual(expect.arrayContaining([blockerChanged, landingChanged]));
    await ok("DELETE", `/api/tickets/${blocker.id}/relations/${relation.id}`, as);
    expect(await changedTickets()).toEqual(expect.arrayContaining([blockerChanged, landingChanged]));
    stream.close();
  });
});

describe("the order of Tickets within a Status", () => {
  test("running Tickets come first, then blocked ones, then the rest, each by number; running beats blocked", async () => {
    const { workspace, ada: as, project, status, ticket, blocks } = await ada();
    const runner = await ok("POST", "/api/runners", as, { name: "Fake", kind: "fake" });
    await ok("PATCH", `/api/runners/${runner.id}`, as, { limit: 3 });
    const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, as, { name: "claude-max" });
    const agent = await ok("PATCH", `/api/agents/${created.id}`, as, { runnerId: runner.id });
    const blocker = await ticket("Blocker"); // CRONK-1, left in Backlog
    const [blockedA, plain, runningA, blockedB, runningB, runningAndBlocked] = [
      await ticket("Blocked A"), // CRONK-2
      await ticket("Plain"), // CRONK-3
      await ticket("Running A"), // CRONK-4
      await ticket("Blocked B"), // CRONK-5
      await ticket("Running B"), // CRONK-6
      await ticket("Running and blocked"), // CRONK-7
    ];
    await blocks(blocker, blockedA);
    await blocks(blocker, blockedB);
    const triage = status("Triage");
    for (const t of [blockedA, plain, blockedB]) await ok("PATCH", `/api/tickets/${t.id}`, as, { statusId: triage });
    for (const t of [runningA, runningB, runningAndBlocked]) {
      await ok("PATCH", `/api/tickets/${t.id}`, as, { delegateId: agent.id, statusId: triage });
    }
    // Blocked once its Run is running, which a block added later leaves running.
    await blocks(blocker, runningAndBlocked);

    const tickets = await ok("GET", `/api/projects/${project.id}/tickets`, as);
    const inTriage = tickets.filter((t: { statusId: string }) => t.statusId === triage);
    type Listed = { key: string; lastRun: { state: string } | null; blockedBy: unknown[] };
    expect(inTriage.map((t: Listed) => [t.key, t.lastRun?.state ?? null, t.blockedBy.length])).toEqual([
      ["CRONK-4", "running", 0],
      ["CRONK-6", "running", 0],
      ["CRONK-7", "running", 1],
      ["CRONK-2", null, 1],
      ["CRONK-5", null, 1],
      ["CRONK-3", null, 0],
    ]);
    // The Statuses keep their order: Backlog's Ticket still comes before Triage's.
    expect(tickets[0].key).toBe("CRONK-1");
  });
});
