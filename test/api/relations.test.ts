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

interface TicketRef {
  id: string;
  projectId: string;
  key: string;
  title: string;
}

async function createProject(cookie: string, workspaceId: string, name: string, key: string) {
  const response = await cronk.request("POST", `/api/workspaces/${workspaceId}/projects`, {
    cookie,
    body: { name, key },
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string };
}

async function createTicket(cookie: string, projectId: string, title: string): Promise<TicketRef> {
  const response = await cronk.request("POST", `/api/projects/${projectId}/tickets`, { cookie, body: { title } });
  expect(response.status).toBe(201);
  const { id, key } = await response.json();
  return { id, projectId, key, title };
}

/** A Workspace with one Project and the given Tickets in it, keyed CRONK-1, CRONK-2… in order. */
async function withTickets(...titles: string[]) {
  const { user, workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const project = await createProject(cookie, workspace.id, "Cronker", "CRONK");
  const tickets: TicketRef[] = [];
  for (const title of titles) tickets.push(await createTicket(cookie, project.id, title));
  return { user, workspace, cookie, project, tickets };
}

const relate = (cookie: string, ticketId: string, kind: string, otherId: string) =>
  cronk.request("POST", `/api/tickets/${ticketId}/relations`, { cookie, body: { kind, ticketId: otherId } });

async function relationsOf(cookie: string, ticketId: string) {
  const response = await cronk.request("GET", `/api/tickets/${ticketId}/relations`, { cookie });
  expect(response.status).toBe(200);
  return response.json();
}

describe("Relations", () => {
  test("a Ticket that blocks another shows as blocking it, and the other as blocked by it", async () => {
    const { cookie, tickets } = await withTickets("Sign in", "Board");
    const [signInTicket, board] = tickets as [TicketRef, TicketRef];

    const response = await relate(cookie, signInTicket.id, "blocks", board.id);

    expect(response.status).toBe(201);
    const relation = await response.json();
    expect(relation).toEqual({ id: expect.any(String), kind: "blocks", ticket: board });
    expect(await relationsOf(cookie, signInTicket.id)).toEqual({
      parent: null,
      subTickets: [],
      relations: [{ id: relation.id, kind: "blocks", ticket: board }],
    });
    expect(await relationsOf(cookie, board.id)).toEqual({
      parent: null,
      subTickets: [],
      relations: [{ id: relation.id, kind: "blockedBy", ticket: signInTicket }],
    });
  });

  test("a blocker can be added from the blocked Ticket's side", async () => {
    const { cookie, tickets } = await withTickets("Sign in", "Board");
    const [signInTicket, board] = tickets as [TicketRef, TicketRef];

    const response = await relate(cookie, board.id, "blockedBy", signInTicket.id);

    expect(response.status).toBe(201);
    expect((await relationsOf(cookie, signInTicket.id)).relations).toEqual([
      { id: expect.any(String), kind: "blocks", ticket: board },
    ]);
    expect((await relationsOf(cookie, board.id)).relations).toEqual([
      { id: expect.any(String), kind: "blockedBy", ticket: signInTicket },
    ]);
  });

  test("two related Tickets each show they relate to the other", async () => {
    const { cookie, tickets } = await withTickets("Board", "List");
    const [board, list] = tickets as [TicketRef, TicketRef];

    const response = await relate(cookie, board.id, "relatesTo", list.id);

    expect(response.status).toBe(201);
    expect((await relationsOf(cookie, board.id)).relations).toEqual([
      { id: expect.any(String), kind: "relatesTo", ticket: list },
    ]);
    expect((await relationsOf(cookie, list.id)).relations).toEqual([
      { id: expect.any(String), kind: "relatesTo", ticket: board },
    ]);
  });

  test("Tickets of different Projects in one Workspace may be related", async () => {
    const { cookie, workspace, tickets } = await withTickets("Board");
    const ops = await createProject(cookie, workspace.id, "Operations", "OPS");
    const deploy = await createTicket(cookie, ops.id, "Deploy");

    const response = await relate(cookie, tickets[0]!.id, "blocks", deploy.id);

    expect(response.status).toBe(201);
    expect((await relationsOf(cookie, deploy.id)).relations).toEqual([
      { id: expect.any(String), kind: "blockedBy", ticket: tickets[0] },
    ]);
  });

  test("the other Ticket may be named by its key, matched ignoring case", async () => {
    const { cookie, workspace, tickets } = await withTickets("Board");
    const ops = await createProject(cookie, workspace.id, "Operations", "OPS");
    const deploy = await createTicket(cookie, ops.id, "Deploy");

    const response = await cronk.request("POST", `/api/tickets/${tickets[0]!.id}/relations`, {
      cookie,
      body: { kind: "blockedBy", ticketKey: "ops-1" },
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: expect.any(String), kind: "blockedBy", ticket: deploy });
    for (const body of [{ kind: "blocks", ticketKey: "OPS-2" }, { kind: "blocks" }]) {
      const refused = await cronk.request("POST", `/api/tickets/${tickets[0]!.id}/relations`, { cookie, body });
      expect(refused.status).toBe(400);
    }
  });

  test("a Ticket of another Workspace, or none at all, is refused", async () => {
    const { cookie, tickets } = await withTickets("Board");
    const created = await cronk.request("POST", "/api/workspaces", { cookie, body: { name: "Elsewhere" } });
    const elsewhere = await createProject(cookie, (await created.json()).id, "Elsewhere", "ELSE");
    const foreign = await createTicket(cookie, elsewhere.id, "Not here");

    for (const otherId of [foreign.id, "00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
      const response = await relate(cookie, tickets[0]!.id, "blocks", otherId);
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("unknown_ticket");
    }
    expect((await relationsOf(cookie, tickets[0]!.id)).relations).toEqual([]);
  });

  test("a Ticket can't be related to itself", async () => {
    const { cookie, tickets } = await withTickets("Board");

    for (const kind of ["blocks", "blockedBy", "relatesTo"]) {
      const response = await relate(cookie, tickets[0]!.id, kind, tickets[0]!.id);
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("relation_to_itself");
    }
  });

  test("the same Relation twice is refused, whichever side it is made from", async () => {
    const { cookie, tickets } = await withTickets("Board", "List");
    const [board, list] = tickets as [TicketRef, TicketRef];
    expect((await relate(cookie, board.id, "relatesTo", list.id)).status).toBe(201);
    expect((await relate(cookie, board.id, "blocks", list.id)).status).toBe(201);

    for (const [from, kind, to] of [
      [board, "relatesTo", list],
      [list, "relatesTo", board],
      [board, "blocks", list],
      [list, "blockedBy", board],
    ] as const) {
      const response = await relate(cookie, from.id, kind, to.id);
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("relation_exists");
    }
    expect((await relationsOf(cookie, board.id)).relations).toHaveLength(2);
  });

  test("Relations of a Ticket the User can't see answer 404", async () => {
    const { cookie, tickets } = await withTickets("Board");

    for (const id of ["00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
      expect((await cronk.request("GET", `/api/tickets/${id}/relations`, { cookie })).status).toBe(404);
      expect((await relate(cookie, id, "blocks", tickets[0]!.id)).status).toBe(404);
    }
  });

  test("a block that would form a cycle is refused, however long the cycle", async () => {
    const { cookie, tickets } = await withTickets("Sign in", "Board", "List");
    const [signInTicket, board, list] = tickets as [TicketRef, TicketRef, TicketRef];
    expect((await relate(cookie, signInTicket.id, "blocks", board.id)).status).toBe(201);
    expect((await relate(cookie, board.id, "blocks", list.id)).status).toBe(201);

    for (const [from, kind, to] of [
      [board, "blocks", signInTicket],
      [signInTicket, "blockedBy", board],
      [list, "blocks", signInTicket],
      [signInTicket, "blockedBy", list],
    ] as const) {
      const response = await relate(cookie, from.id, kind, to.id);
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("blocking_cycle");
    }
    expect((await relationsOf(cookie, signInTicket.id)).relations).toEqual([
      { id: expect.any(String), kind: "blocks", ticket: board },
    ]);
  });

  test("blocks that don't close a loop are allowed, and relating never forms a cycle", async () => {
    const { cookie, tickets } = await withTickets("Sign in", "Board", "List");
    const [signInTicket, board, list] = tickets as [TicketRef, TicketRef, TicketRef];
    expect((await relate(cookie, signInTicket.id, "blocks", board.id)).status).toBe(201);
    expect((await relate(cookie, board.id, "blocks", list.id)).status).toBe(201);

    expect((await relate(cookie, signInTicket.id, "blocks", list.id)).status).toBe(201);
    expect((await relate(cookie, list.id, "relatesTo", signInTicket.id)).status).toBe(201);
  });

  test("a Relation can be removed from either of its Tickets", async () => {
    const { cookie, tickets } = await withTickets("Sign in", "Board", "List");
    const [signInTicket, board, list] = tickets as [TicketRef, TicketRef, TicketRef];
    const blocks = await (await relate(cookie, signInTicket.id, "blocks", board.id)).json();
    const relates = await (await relate(cookie, board.id, "relatesTo", list.id)).json();

    const fromBlocked = await cronk.request("DELETE", `/api/tickets/${board.id}/relations/${blocks.id}`, { cookie });
    const fromOther = await cronk.request("DELETE", `/api/tickets/${list.id}/relations/${relates.id}`, { cookie });

    expect(fromBlocked.status).toBe(204);
    expect(fromOther.status).toBe(204);
    for (const ticket of tickets) expect((await relationsOf(cookie, ticket.id)).relations).toEqual([]);
    expect((await relate(cookie, board.id, "blocks", signInTicket.id)).status).toBe(201);
  });

  test("removing a Relation the Ticket doesn't have answers 404", async () => {
    const { cookie, tickets } = await withTickets("Sign in", "Board", "List");
    const [signInTicket, board, list] = tickets as [TicketRef, TicketRef, TicketRef];
    const blocks = await (await relate(cookie, signInTicket.id, "blocks", board.id)).json();

    for (const [ticketId, relationId] of [
      [list.id, blocks.id],
      [signInTicket.id, "00000000-0000-4000-8000-000000000000"],
      [signInTicket.id, "not-a-uuid"],
      ["not-a-uuid", blocks.id],
    ]) {
      const response = await cronk.request("DELETE", `/api/tickets/${ticketId}/relations/${relationId}`, { cookie });
      expect(response.status).toBe(404);
    }
    expect((await relationsOf(cookie, board.id)).relations).toHaveLength(1);
  });
});

const setParent = (cookie: string, ticketId: string, parentId: string | null) =>
  cronk.request("PATCH", `/api/tickets/${ticketId}`, { cookie, body: { parentId } });

describe("Sub-Tickets", () => {
  test("a Ticket made a Sub-Ticket names its parent, and the parent lists its Sub-Tickets by key", async () => {
    const { cookie, tickets } = await withTickets("Relations", "Cycle check", "Ticket view");
    const [parent, cycles, view] = tickets as [TicketRef, TicketRef, TicketRef];

    const response = await setParent(cookie, view.id, parent.id);
    expect(response.status).toBe(200);
    expect((await response.json()).parentId).toBe(parent.id);
    expect((await setParent(cookie, cycles.id, parent.id)).status).toBe(200);

    expect(await relationsOf(cookie, parent.id)).toEqual({ parent: null, subTickets: [cycles, view], relations: [] });
    expect(await relationsOf(cookie, view.id)).toEqual({ parent, subTickets: [], relations: [] });
    expect((await (await cronk.request("GET", `/api/tickets/${view.id}`, { cookie })).json()).parentId).toBe(parent.id);
  });

  test("clearing the parent makes the Ticket stand alone again", async () => {
    const { cookie, tickets } = await withTickets("Relations", "Ticket view");
    const [parent, view] = tickets as [TicketRef, TicketRef];
    await setParent(cookie, view.id, parent.id);

    const response = await setParent(cookie, view.id, null);

    expect(response.status).toBe(200);
    expect((await response.json()).parentId).toBeNull();
    expect((await relationsOf(cookie, parent.id)).subTickets).toEqual([]);
    expect((await relationsOf(cookie, view.id)).parent).toBeNull();
  });

  test("a parent in another Project is refused", async () => {
    const { cookie, workspace, tickets } = await withTickets("Ticket view");
    const ops = await createProject(cookie, workspace.id, "Operations", "OPS");
    const deploy = await createTicket(cookie, ops.id, "Deploy");

    const response = await setParent(cookie, tickets[0]!.id, deploy.id);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("parent_in_other_project");
    expect((await relationsOf(cookie, tickets[0]!.id)).parent).toBeNull();
  });

  test("a parent that isn't a Ticket of the Workspace is refused", async () => {
    const { cookie, tickets } = await withTickets("Ticket view");
    const created = await cronk.request("POST", "/api/workspaces", { cookie, body: { name: "Elsewhere" } });
    const elsewhere = await createProject(cookie, (await created.json()).id, "Elsewhere", "ELSE");
    const foreign = await createTicket(cookie, elsewhere.id, "Not here");

    for (const parentId of [foreign.id, "00000000-0000-4000-8000-000000000000"]) {
      const response = await setParent(cookie, tickets[0]!.id, parentId);
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("unknown_ticket");
    }
  });

  test("a parent cycle is refused: a Ticket can't sit under itself or under its own Sub-Tickets", async () => {
    const { cookie, tickets } = await withTickets("Relations", "Ticket view", "Lists");
    const [relations, view, lists] = tickets as [TicketRef, TicketRef, TicketRef];
    expect((await setParent(cookie, view.id, relations.id)).status).toBe(200);
    expect((await setParent(cookie, lists.id, view.id)).status).toBe(200);

    for (const [ticket, parent] of [
      [relations, relations],
      [relations, view],
      [relations, lists],
    ] as const) {
      const response = await setParent(cookie, ticket.id, parent.id);
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("parent_cycle");
    }
    expect((await relationsOf(cookie, relations.id)).parent).toBeNull();
  });
});

describe("a Sub-Ticket's Delegation", () => {
  async function createAgent(cookie: string, workspaceId: string, name: string) {
    const response = await cronk.request("POST", `/api/workspaces/${workspaceId}/agents`, { cookie, body: { name } });
    expect(response.status).toBe(201);
    return (await response.json()) as { id: string; name: string };
  }

  /** One of the User's Agents, using a fake Runner of theirs, so it gets Runs. */
  async function agentWithRunner(cookie: string, workspaceId: string, name: string) {
    const runner = await cronk.request("POST", "/api/runners", { cookie, body: { name: "Fake", kind: "fake" } });
    expect(runner.status).toBe(201);
    const agent = await createAgent(cookie, workspaceId, name);
    const body = { runnerId: (await runner.json()).id };
    expect((await cronk.request("PATCH", `/api/agents/${agent.id}`, { cookie, body })).status).toBe(200);
    return agent;
  }

  async function edit(cookie: string, ticketId: string, body: Record<string, unknown>) {
    const response = await cronk.request("PATCH", `/api/tickets/${ticketId}`, { cookie, body });
    expect(response.status).toBe(200);
    return response.json();
  }

  async function changesOf(cookie: string, ticketId: string) {
    return (await timelineOf(cookie, ticketId)).map(({ field, from, to }) => ({ field, from, to }));
  }

  test("an undelegated Ticket put under a delegated parent takes the parent's Assignee and Delegate", async () => {
    const { cookie, workspace, tickets } = await withTickets("Relations", "Ticket view");
    const [parent, view] = tickets as [TicketRef, TicketRef];
    const bea = await addMember(cronk, cookie, workspace.id, "bea@example.com");
    const beasAgent = await createAgent(bea.cookie, workspace.id, "bea-bot");
    await edit(bea.cookie, parent.id, { delegateId: beasAgent.id });

    const subTicket = await edit(cookie, view.id, { parentId: parent.id });

    expect(subTicket).toEqual(expect.objectContaining({ assigneeId: bea.user.id, delegateId: beasAgent.id }));
    expect(await changesOf(cookie, view.id)).toEqual(
      expect.arrayContaining([
        { field: "assignee", from: null, to: { id: bea.user.id, name: "bea@example.com" } },
        { field: "delegate", from: null, to: { id: beasAgent.id, name: "bea-bot" } },
      ]),
    );
  });

  test("a Ticket with its own Delegation is re-delegated to the parent's Delegate, stopping its running Run", async () => {
    const { user, cookie, workspace, project, tickets } = await withTickets("Relations", "Ticket view");
    const [parent, view] = tickets as [TicketRef, TicketRef];
    const adasAgent = await agentWithRunner(cookie, workspace.id, "claude-max");
    const board = await (await cronk.request("GET", `/api/projects/${project.id}`, { cookie })).json();
    const triage = board.statuses.find((s: { name: string }) => s.name === "Triage").id;
    await edit(cookie, view.id, { delegateId: adasAgent.id, statusId: triage });
    const runsOf = async () => (await cronk.request("GET", `/api/tickets/${view.id}/runs`, { cookie })).json();
    const [run] = await runsOf();
    expect(run.state).toBe("running");
    const bea = await addMember(cronk, cookie, workspace.id, "bea@example.com");
    const beasAgent = await agentWithRunner(bea.cookie, workspace.id, "bea-bot");
    await edit(bea.cookie, parent.id, { delegateId: beasAgent.id });

    const subTicket = await edit(cookie, view.id, { parentId: parent.id });

    expect(subTicket).toEqual(expect.objectContaining({ assigneeId: bea.user.id, delegateId: beasAgent.id }));
    expect(await changesOf(cookie, view.id)).toEqual(
      expect.arrayContaining([
        { field: "assignee", from: { id: user.id, name: "ada@example.com" }, to: { id: bea.user.id, name: "bea@example.com" } },
        { field: "delegate", from: { id: adasAgent.id, name: "claude-max" }, to: { id: beasAgent.id, name: "bea-bot" } },
      ]),
    );
    const runs = await runsOf();
    expect(runs.find((r: { id: string }) => r.id === run.id)).toEqual(
      expect.objectContaining({
        state: "stopped",
        endReason: `ada@example.com put ${view.key} under ${parent.key}, delegating it to bea-bot.`,
      }),
    );
    expect(runs.find((r: { id: string }) => r.id !== run.id)).toEqual(
      expect.objectContaining({ state: "running", agent: { id: beasAgent.id, name: "bea-bot" } }),
    );
  });

  test("a Delegation given along with the parent wins over the parent's", async () => {
    const { user, cookie, workspace, tickets } = await withTickets("Relations", "Ticket view");
    const [parent, view] = tickets as [TicketRef, TicketRef];
    const agent = await createAgent(cookie, workspace.id, "claude-max");
    const bea = await addMember(cronk, cookie, workspace.id, "bea@example.com");
    await edit(bea.cookie, parent.id, { delegateId: (await createAgent(bea.cookie, workspace.id, "bea-bot")).id });

    const subTicket = await edit(cookie, view.id, { parentId: parent.id, delegateId: agent.id });

    expect(subTicket).toEqual(expect.objectContaining({ parentId: parent.id, assigneeId: user.id, delegateId: agent.id }));
  });

  test("a Ticket keeps its own Delegation under an undelegated parent", async () => {
    const { user, cookie, workspace, tickets } = await withTickets("Relations", "Ticket view");
    const [parent, view] = tickets as [TicketRef, TicketRef];
    const agent = await createAgent(cookie, workspace.id, "claude-max");
    await edit(cookie, view.id, { delegateId: agent.id });

    const subTicket = await edit(cookie, view.id, { parentId: parent.id });

    expect(subTicket).toEqual(expect.objectContaining({ assigneeId: user.id, delegateId: agent.id }));
  });
});

async function timelineOf(cookie: string, ticketId: string) {
  const response = await cronk.request("GET", `/api/tickets/${ticketId}/timeline`, { cookie });
  expect(response.status).toBe(200);
  const changes: { field: string; from: unknown; to: unknown; actor: { id: string }; at: string }[] =
    await response.json();
  return changes.filter((change) => change.field !== "created");
}

describe("the timeline", () => {
  test("adding and removing Relations shows on both Tickets' timelines", async () => {
    const { user, cookie, tickets } = await withTickets("Sign in", "Board", "List");
    const [signInTicket, board, list] = tickets as [TicketRef, TicketRef, TicketRef];
    const blocks = await (await relate(cookie, board.id, "blockedBy", signInTicket.id)).json();
    cronk.clock.advance(60_000);
    await relate(cookie, board.id, "relatesTo", list.id);
    cronk.clock.advance(60_000);
    await cronk.request("DELETE", `/api/tickets/${signInTicket.id}/relations/${blocks.id}`, { cookie });

    const by = { actor: expect.objectContaining({ id: user.id }), runId: null };
    expect(await timelineOf(cookie, signInTicket.id)).toEqual([
      { ...by, id: expect.any(String), at: "2026-01-01T09:00:00.000Z", field: "blocks", from: null, to: board },
      { ...by, id: expect.any(String), at: "2026-01-01T09:02:00.000Z", field: "blocks", from: board, to: null },
    ]);
    expect(await timelineOf(cookie, board.id)).toEqual([
      {
        ...by,
        id: expect.any(String),
        at: "2026-01-01T09:00:00.000Z",
        field: "blockedBy",
        from: null,
        to: signInTicket,
      },
      { ...by, id: expect.any(String), at: "2026-01-01T09:01:00.000Z", field: "relatesTo", from: null, to: list },
      {
        ...by,
        id: expect.any(String),
        at: "2026-01-01T09:02:00.000Z",
        field: "blockedBy",
        from: signInTicket,
        to: null,
      },
    ]);
    expect(await timelineOf(cookie, list.id)).toEqual([
      { ...by, id: expect.any(String), at: "2026-01-01T09:01:00.000Z", field: "relatesTo", from: null, to: board },
    ]);
  });

  test("setting, moving and clearing a parent shows on the Sub-Ticket's and each parent's timeline", async () => {
    const { cookie, tickets } = await withTickets("Relations", "Views", "Ticket view");
    const [relations, views, view] = tickets as [TicketRef, TicketRef, TicketRef];

    await setParent(cookie, view.id, relations.id);
    await setParent(cookie, view.id, views.id);
    await setParent(cookie, view.id, null);

    const shown = async (ticket: TicketRef) =>
      (await timelineOf(cookie, ticket.id)).map(({ field, from, to }) => ({ field, from, to }));
    expect(await shown(view)).toEqual([
      { field: "parent", from: null, to: relations },
      { field: "parent", from: relations, to: views },
      { field: "parent", from: views, to: null },
    ]);
    expect(await shown(relations)).toEqual([
      { field: "subTicket", from: null, to: view },
      { field: "subTicket", from: view, to: null },
    ]);
    expect(await shown(views)).toEqual([
      { field: "subTicket", from: null, to: view },
      { field: "subTicket", from: view, to: null },
    ]);
  });
});
