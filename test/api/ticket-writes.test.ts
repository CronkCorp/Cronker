import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { hours } from "../harness/clock.js";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";
import { openStream, type LiveEvent, type OpenStream } from "../harness/stream.js";

let cronk: StartedCronk;
const streams: OpenStream[] = [];
beforeEach(async () => {
  cronk = await startCronk();
});
afterEach(async () => {
  for (const stream of streams.splice(0)) stream.close();
  await cronk?.stop();
});

interface Request {
  cookie?: string;
  headers?: Record<string, string>;
}

async function ok(method: string, path: string, as: Request, body?: unknown) {
  const response = await cronk.request(method, path, { ...as, body });
  const json = response.status === 204 ? null : await response.json();
  expect(response.status, `${method} ${path}: ${JSON.stringify(json)}`).toBeLessThan(300);
  return json;
}

/** Ada with a Project on the default board, a Ticket in Backlog, and her Agent using her fake Runner. */
async function adaWithAgent() {
  const { workspace } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Pick a colour" });
  const runner = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, ada, { runnerId: runner.id });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "cloud", access: "write" });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id as string;
  const asAgent = { headers: { authorization: `Bearer ${secret}` } };
  const stream = async () => {
    const opened = await openStream(cronk, ada.cookie, workspace.id);
    streams.push(opened);
    return opened;
  };
  return { workspace, ada, project, ticket, agent, asAgent, status, stream };
}

const changed = (projectId: string, ticketId: string) => ({ type: "ticket.changed", data: { projectId, ticketId } });

/** The events the stream receives until it falls quiet. */
async function received(events: OpenStream): Promise<LiveEvent[]> {
  const all: LiveEvent[] = [];
  for (;;) {
    try {
      all.push(await events.next(300));
    } catch {
      return all;
    }
  }
}

/** The `ticket.changed` events for the Ticket among those received. */
const changesTo = (all: LiveEvent[], ticketId: string) =>
  all.filter((event) => event.type === "ticket.changed" && event.data.ticketId === ticketId);

/** The `ticket.changed` events for the Ticket the stream receives until it falls quiet. */
const changesOf = async (events: OpenStream, ticketId: string) => changesTo(await received(events), ticketId);

type Change = { field: string; actor: { kind: string; name: string }; from: unknown; to: unknown };
const timelineOf = (ticketId: string, as: Request): Promise<Change[]> => ok("GET", `/api/tickets/${ticketId}/timeline`, as);

describe("a Ticket edit, through the Ticket write module", () => {
  test("a Status change moves the time it entered its Status and takes a needs you Ticket out of the Inbox", async () => {
    const { workspace, ada, ticket, agent, asAgent, status } = await adaWithAgent();
    const inbox = () => ok("GET", `/api/workspaces/${workspace.id}/inbox`, ada);
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Investigate") });
    const [run] = await ok("GET", `/api/tickets/${ticket.id}/runs`, ada);
    await ok("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "needs you", question: "Blue or green?" });
    const [question] = (await inbox()).items;
    await ok("POST", `/api/questions/${question.question.id}/dismiss`, ada);
    expect((await inbox()).items).toEqual([
      expect.objectContaining({ kind: "needsYou", since: "2026-01-01T09:00:00.000Z" }),
    ]);

    cronk.clock.advance(hours(3));
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("In Review") });

    expect(await inbox()).toEqual({
      count: 1,
      items: [
        expect.objectContaining({
          kind: "review",
          status: { id: status("In Review"), name: "In Review" },
          since: "2026-01-01T12:00:00.000Z",
        }),
      ],
    });
  });

  test("an edit that changes nothing leaves no Change and sends no event", async () => {
    const { ada, ticket, project, stream } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { priority: "high", labels: ["ui"], estimate: 3 });
    const before = await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada);
    const events = await stream();

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, {
      title: "Pick a colour",
      priority: "high",
      labels: ["ui"],
      estimate: 3,
      assigneeId: null,
      parentId: null,
    });

    await events.expectQuiet();
    expect(await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada)).toEqual(before);
    // A real change after it is told, so the stream was listening.
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { priority: "low" });
    expect(await events.next()).toEqual(changed(project.id, ticket.id));
  });
});

describe("passing Autonomous Delegation down", () => {
  test("records one Change and sends one event per Sub-Ticket, however deep", async () => {
    const { ada, project, ticket, stream } = await adaWithAgent();
    const newSubTicket = (parentId: string, title: string) =>
      ok("POST", `/api/projects/${project.id}/tickets`, ada, { title, parentId });
    const child = await newSubTicket(ticket.id, "Child");
    const grandchild = await newSubTicket(child.id, "Grandchild");
    const sibling = await newSubTicket(ticket.id, "Sibling");
    const events = await stream();

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { autonomousDelegation: true });

    const received = [await events.next(), await events.next(), await events.next(), await events.next()];
    await events.expectQuiet();
    expect(received).toHaveLength(4);
    expect(new Set(received.map((event) => JSON.stringify(event)))).toEqual(
      new Set([ticket, child, grandchild, sibling].map((t) => JSON.stringify(changed(project.id, t.id)))),
    );
    for (const subTicket of [child, grandchild, sibling]) {
      const timeline = await ok("GET", `/api/tickets/${subTicket.id}/timeline`, ada);
      expect(timeline.filter((c: { field: string }) => c.field === "autonomousDelegation")).toEqual([
        expect.objectContaining({ field: "autonomousDelegation", from: null, to: true }),
      ]);
    }
  });
});

describe("the other Ticket writes, through the Ticket write module", () => {
  test("a Run's Outcome moves its Ticket as Cronk's move: one event, the move recorded and timed, and needs you in the Inbox", async () => {
    const { workspace, ada, project, ticket, agent, asAgent, status, stream } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Investigate") });
    const [run] = await ok("GET", `/api/tickets/${ticket.id}/runs`, ada);
    const events = await stream();
    cronk.clock.advance(hours(2));

    await ok("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "needs you", question: "Blue or green?" });

    expect(await changesOf(events, ticket.id)).toEqual([changed(project.id, ticket.id)]);
    const moved = await ok("GET", `/api/tickets/${ticket.id}`, ada);
    const [last] = (await timelineOf(ticket.id, ada)).slice(-1);
    expect(last).toEqual(
      expect.objectContaining({
        field: "status",
        actor: expect.objectContaining({ kind: "agent", name: "claude-max" }),
        from: { id: status("Investigate"), name: "Investigate" },
        to: { id: moved.statusId, name: expect.any(String) },
      }),
    );
    const { items } = await ok("GET", `/api/workspaces/${workspace.id}/inbox`, ada);
    expect(items).toContainEqual(expect.objectContaining({ kind: "needsYou", since: "2026-01-01T11:00:00.000Z" }));
  });

  test("a skipped Step moves the Ticket as Cronk, recording the skip before the move, in the one event of the edit", async () => {
    const { workspace, ada, project, ticket, agent, status, stream } = await adaWithAgent();
    const { step } = project.statuses.find((s: { name: string }) => s.name === "Code review");
    await ok("PUT", `/api/projects/${project.id}/statuses/${status("Code review")}/step`, ada, {
      ...step,
      labelRule: { kind: "skippedBy", label: "no-review" },
    });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, labels: ["no-review"] });
    const events = await stream();
    cronk.clock.advance(hours(1));

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Code review") });

    expect(await changesOf(events, ticket.id)).toEqual([changed(project.id, ticket.id)]);
    const timeline = await timelineOf(ticket.id, ada);
    // Code review skips itself by its Label rule, then the default board's Merge Step skips itself too.
    expect(timeline.slice(-5).map((c) => [c.actor.kind, c.field])).toEqual([
      ["user", "status"],
      ["cronk", "stepSkipped"],
      ["cronk", "status"],
      ["cronk", "stepSkipped"],
      ["cronk", "status"],
    ]);
    expect(timeline.at(-1)).toEqual(
      expect.objectContaining({ actor: { kind: "cronk", name: "Cronk" }, field: "status", to: { id: status("In Review"), name: "In Review" } }),
    );
    const { items } = await ok("GET", `/api/workspaces/${workspace.id}/inbox`, ada);
    expect(items).toContainEqual(expect.objectContaining({ kind: "review", since: "2026-01-01T10:00:00.000Z" }));
  });

  test("a Runner's rate limit marks the Ticket waiting for a Run: told live, with no Change", async () => {
    const { ada, project, ticket, agent, status, stream } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id });
    const before = await timelineOf(ticket.id, ada);
    const events = await stream();
    cronk.runner.refuseNext({ kind: "rate_limited", message: "Too many fires.", retryAt: new Date("2026-01-01T10:00:00Z") });

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Triage") });

    // One for the edit, and one for the wait the refused start leaves, after the edit committed.
    expect(await changesOf(events, ticket.id)).toEqual([changed(project.id, ticket.id), changed(project.id, ticket.id)]);
    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).waiting).toBe("runnerPaused");
    expect((await timelineOf(ticket.id, ada)).slice(before.length).map((c) => c.field)).toEqual(["status"]);
  });

  test("answering a Question moves the Ticket back to the Step that asked, in one event", async () => {
    const { ada, project, ticket, agent, asAgent, status, stream } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Investigate") });
    const [run] = await ok("GET", `/api/tickets/${ticket.id}/runs`, ada);
    await ok("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "needs you", question: "Blue or green?" });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: null });
    const comments = await ok("GET", `/api/tickets/${ticket.id}/comments`, ada);
    const events = await stream();

    await ok("POST", `/api/tickets/${ticket.id}/comments`, ada, { body: "Green.", replyToId: comments.at(-1).id });

    expect(await changesOf(events, ticket.id)).toEqual([changed(project.id, ticket.id)]);
    expect((await timelineOf(ticket.id, ada)).at(-1)).toEqual(
      expect.objectContaining({ field: "status", actor: expect.objectContaining({ kind: "user" }), to: { id: status("Investigate"), name: "Investigate" } }),
    );
  });

  /** Ada's Ticket completed Unverified by its Code review Run, then undelegated so Reopen starts no Run. */
  async function completed() {
    const setup = await adaWithAgent();
    const { ada, ticket, agent, asAgent, status } = setup;
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { autonomousDelegation: true, delegateId: agent.id });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Code review") });
    const [run] = await ok("GET", `/api/tickets/${ticket.id}/runs`, ada);
    await ok("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "complete" });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: null });
    return setup;
  }

  test("a Run completing its Ticket records the move, then Unverified", async () => {
    const { ada, ticket, status } = await completed();
    const timeline = await timelineOf(ticket.id, ada);
    expect(timeline.slice(-3, -1).map((c) => [c.actor.kind, c.field, c.from, c.to])).toEqual([
      ["agent", "status", { id: status("Code review"), name: "Code review" }, { id: status("Done"), name: "Done" }],
      ["agent", "verification", null, "unverified"],
    ]);
  });

  test("Accept sends one event and records Verified", async () => {
    const { ada, project, ticket, stream } = await completed();
    const events = await stream();

    await ok("POST", `/api/tickets/${ticket.id}/accept`, ada);

    expect(await changesOf(events, ticket.id)).toEqual([changed(project.id, ticket.id)]);
    expect((await timelineOf(ticket.id, ada)).at(-1)).toEqual(
      expect.objectContaining({ field: "verification", from: "unverified", to: "verified" }),
    );
  });

  test("Reopen sends one event and records the move and verification after its Comment", async () => {
    const { ada, project, ticket, status, stream } = await completed();
    const events = await stream();

    await ok("POST", `/api/tickets/${ticket.id}/reopen`, ada, { comment: "Not yet." });

    expect(await changesOf(events, ticket.id)).toEqual([changed(project.id, ticket.id)]);
    expect((await timelineOf(ticket.id, ada)).slice(-2).map((c) => [c.field, c.to])).toEqual([
      ["status", { id: status("Code review"), name: "Code review" }],
      ["verification", null],
    ]);
    const comments = await ok("GET", `/api/tickets/${ticket.id}/comments`, ada);
    expect(comments.at(-1)).toEqual(expect.objectContaining({ body: "Not yet." }));
  });

  test("a member leaving is taken off their Tickets one at a time: one event each, recorded as the Admin's", async () => {
    const { workspace, ada, project, stream } = await adaWithAgent();
    const bea = await addMember(cronk, ada.cookie, workspace.id, "bea@example.com");
    const first = await ok("POST", `/api/projects/${project.id}/tickets`, { cookie: bea.cookie }, { title: "Bea's first" });
    const second = await ok("POST", `/api/projects/${project.id}/tickets`, { cookie: bea.cookie }, { title: "Bea's second" });
    await ok("PATCH", `/api/tickets/${first.id}`, ada, { assigneeId: bea.user.id });
    await ok("PATCH", `/api/tickets/${second.id}`, ada, { assigneeId: bea.user.id });
    const events = await stream();

    await ok("DELETE", `/api/workspaces/${workspace.id}/members/${bea.user.id}`, ada);

    const all = await received(events);
    for (const ticket of [first, second]) expect(changesTo(all, ticket.id)).toEqual([changed(project.id, ticket.id)]);
    for (const ticket of [first, second]) {
      expect((await timelineOf(ticket.id, ada)).at(-1)).toEqual(
        expect.objectContaining({ field: "assignee", actor: expect.objectContaining({ kind: "user", name: "ada@example.com" }), to: null }),
      );
    }
    const { items } = await ok("GET", `/api/workspaces/${workspace.id}/inbox`, ada);
    expect(items.filter((i: { kind: string }) => i.kind === "reassign")).toHaveLength(2);
  });
});
