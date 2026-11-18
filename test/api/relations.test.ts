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
