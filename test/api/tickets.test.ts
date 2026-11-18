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

interface Project {
  id: string;
  key: string;
  statuses: { id: string; name: string; kind: string }[];
}

async function newProject(name = "Cronker", key = "CRONK") {
  const { user, workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const project = await createProject(cookie, workspace.id, name, key);
  const statusId = (status: string) => project.statuses.find((s) => s.name === status)!.id;
  return { user, workspace, cookie, project, statusId };
}

async function createProject(cookie: string, workspaceId: string, name: string, key: string): Promise<Project> {
  const response = await cronk.request("POST", `/api/workspaces/${workspaceId}/projects`, {
    cookie,
    body: { name, key },
  });
  expect(response.status).toBe(201);
  return response.json();
}

async function createTicket(cookie: string, projectId: string, body: { title: string; description?: string }) {
  const response = await cronk.request("POST", `/api/projects/${projectId}/tickets`, { cookie, body });
  expect(response.status).toBe(201);
  return response.json();
}

describe("creating a Ticket", () => {
  test("a new Ticket gets the next key in its Project and starts in the first Backlog Status", async () => {
    const { user, cookie, project, statusId } = await newProject();

    const response = await cronk.request("POST", `/api/projects/${project.id}/tickets`, {
      cookie,
      body: { title: "Drag Tickets on the board", description: "Like **this**." },
    });

    expect(response.status).toBe(201);
    const ticket = await response.json();
    expect(ticket).toEqual({
      id: expect.any(String),
      projectId: project.id,
      key: "CRONK-1",
      title: "Drag Tickets on the board",
      description: "Like **this**.",
      statusId: statusId("Backlog"),
      priority: "none",
      labels: [],
      assigneeId: null,
      delegateId: null,
      parentId: null,
      dueDate: null,
      estimate: null,
      createdBy: user.id,
      createdAt: "2026-01-01T09:00:00.000Z",
      lastRun: null,
      mentions: [],
    });

    const second = await createTicket(cookie, project.id, { title: "Second" });
    expect(second.key).toBe("CRONK-2");
    expect(second.description).toBe("");

    const shown = await cronk.request("GET", `/api/tickets/${ticket.id}`, { cookie });
    expect(shown.status).toBe(200);
    expect(await shown.json()).toEqual(ticket);
  });

  test("keys are numbered per Project", async () => {
    const { workspace, cookie, project } = await newProject();
    const other = await createProject(cookie, workspace.id, "Operations", "OPS");

    await createTicket(cookie, project.id, { title: "One" });
    await createTicket(cookie, project.id, { title: "Two" });
    const ops = await createTicket(cookie, other.id, { title: "First of Operations" });

    expect(ops.key).toBe("OPS-1");
  });

  test("the first Backlog Status is the first on the board, wherever it sits", async () => {
    const { cookie, project, statusId } = await newProject();
    await cronk.request("PATCH", `/api/projects/${project.id}/statuses/${statusId("Ready")}`, {
      cookie,
      body: { position: 0 },
    });

    const ticket = await createTicket(cookie, project.id, { title: "Where do I start?" });

    expect(ticket.statusId).toBe(statusId("Ready"));
  });

  test("a blank title is refused", async () => {
    const { cookie, project } = await newProject();

    const response = await cronk.request("POST", `/api/projects/${project.id}/tickets`, {
      cookie,
      body: { title: "   " },
    });

    expect(response.status).toBe(400);
  });

  test("Tickets of a Project or Ticket the User can't see answer 404", async () => {
    const { cookie } = await newProject();

    for (const id of ["00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
      const created = await cronk.request("POST", `/api/projects/${id}/tickets`, { cookie, body: { title: "T" } });
      expect(created.status).toBe(404);
      expect((await cronk.request("GET", `/api/projects/${id}/tickets`, { cookie })).status).toBe(404);
      expect((await cronk.request("GET", `/api/tickets/${id}`, { cookie })).status).toBe(404);
    }
  });
});

const edit = (cookie: string, ticketId: string, body: unknown) =>
  cronk.request("PATCH", `/api/tickets/${ticketId}`, { cookie, body });

describe("editing a Ticket", () => {
  test("title, description, Priority, Labels, Assignee, due date and estimate are set and cleared", async () => {
    const { user, cookie, project } = await newProject();
    const ticket = await createTicket(cookie, project.id, { title: "Draft" });

    const response = await edit(cookie, ticket.id, {
      title: "Final title",
      description: "New *description*",
      priority: "high",
      labels: ["UI", "board"],
      assigneeId: user.id,
      dueDate: "2026-02-01",
      estimate: 3.5,
    });

    expect(response.status).toBe(200);
    const edited = await response.json();
    expect(edited).toEqual({
      ...ticket,
      title: "Final title",
      description: "New *description*",
      priority: "high",
      labels: ["UI", "board"],
      assigneeId: user.id,
      dueDate: "2026-02-01",
      estimate: 3.5,
    });
    expect(await (await cronk.request("GET", `/api/tickets/${ticket.id}`, { cookie })).json()).toEqual(edited);

    const cleared = await edit(cookie, ticket.id, { assigneeId: null, dueDate: null, estimate: null, labels: [] });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ assigneeId: null, dueDate: null, estimate: null, labels: [] });
  });

  test("Labels that differ only in case are one Label, kept as first written", async () => {
    const { cookie, project } = await newProject();
    const ticket = await createTicket(cookie, project.id, { title: "Labelled" });

    const response = await edit(cookie, ticket.id, { labels: ["Bug", " bug ", "BUG", "no-review"] });

    expect(response.status).toBe(200);
    expect((await response.json()).labels).toEqual(["Bug", "no-review"]);
  });

  test("an Assignee who isn't a member of the Workspace is refused", async () => {
    const { cookie, project } = await newProject();
    const ticket = await createTicket(cookie, project.id, { title: "Who?" });

    const response = await edit(cookie, ticket.id, { assigneeId: "00000000-0000-4000-8000-000000000000" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "assignee_not_member", message: "An Assignee must be a member of this Workspace." },
    });
    expect((await (await cronk.request("GET", `/api/tickets/${ticket.id}`, { cookie })).json()).assigneeId).toBeNull();
  });

  test("an unknown Priority, a malformed due date or a negative estimate is refused", async () => {
    const { cookie, project } = await newProject();
    const ticket = await createTicket(cookie, project.id, { title: "Bad input" });

    for (const body of [{ priority: "critical" }, { dueDate: "next week" }, { estimate: -1 }, { title: "" }]) {
      const response = await edit(cookie, ticket.id, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });

  test("a Ticket the User can't see answers 404", async () => {
    const { cookie } = await newProject();
    const response = await edit(cookie, "00000000-0000-4000-8000-000000000000", { title: "Mine now" });
    expect(response.status).toBe(404);
  });
});

describe("moving a Ticket", () => {
  test("a Ticket moves to any Status of its Project", async () => {
    const { cookie, project, statusId } = await newProject();
    const ticket = await createTicket(cookie, project.id, { title: "On the move" });

    for (const status of ["Done", "Triage", "Canceled", "Backlog"]) {
      const response = await edit(cookie, ticket.id, { statusId: statusId(status) });
      expect(response.status, status).toBe(200);
      expect((await response.json()).statusId).toBe(statusId(status));
    }
  });

  test("a Status of another Project is refused", async () => {
    const { workspace, cookie, project } = await newProject();
    const other = await createProject(cookie, workspace.id, "Operations", "OPS");
    const ticket = await createTicket(cookie, project.id, { title: "Stay here" });

    for (const statusId of [other.statuses[0]!.id, "00000000-0000-4000-8000-000000000000"]) {
      const response = await edit(cookie, ticket.id, { statusId });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: { code: "unknown_status", message: "That Status isn't on this Ticket's board." },
      });
    }
  });
});

describe("removing a Status that holds Tickets", () => {
  async function removeStatus(cookie: string, projectId: string, statusId: string) {
    return cronk.request("DELETE", `/api/projects/${projectId}/statuses/${statusId}`, { cookie });
  }

  async function ticketsIn(cookie: string, projectId: string, statusId: string): Promise<string[]> {
    const response = await cronk.request("GET", `/api/projects/${projectId}/tickets?statusId=${statusId}`, { cookie });
    expect(response.status).toBe(200);
    return (await response.json()).map((t: { title: string }) => t.title);
  }

  test("is refused, naming how many Tickets are in it, and nothing changes", async () => {
    const { cookie, project, statusId } = await newProject();
    for (const title of ["First", "Second"]) {
      const ticket = await createTicket(cookie, project.id, { title });
      expect((await edit(cookie, ticket.id, { statusId: statusId("Ready") })).status).toBe(200);
    }

    const refused = await removeStatus(cookie, project.id, statusId("Ready"));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: {
        code: "status_has_tickets",
        message: "Ready holds 2 Tickets. Move them to another Status before removing Ready.",
      },
    });

    const after = await cronk.request("GET", `/api/projects/${project.id}`, { cookie });
    expect((await after.json()).statuses.map((s: { name: string }) => s.name)).toContain("Ready");
    expect(await ticketsIn(cookie, project.id, statusId("Ready"))).toEqual(["First", "Second"]);
  });

  test("names a single Ticket in the singular", async () => {
    const { cookie, project, statusId } = await newProject();
    const ticket = await createTicket(cookie, project.id, { title: "Alone" });
    expect((await edit(cookie, ticket.id, { statusId: statusId("Ready") })).status).toBe(200);

    const refused = await removeStatus(cookie, project.id, statusId("Ready"));
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.message).toBe(
      "Ready holds 1 Ticket. Move it to another Status before removing Ready.",
    );
  });

  test("once its Tickets move out it is removed, and they stay where they moved", async () => {
    const { cookie, project, statusId } = await newProject();
    const ticket = await createTicket(cookie, project.id, { title: "Moving on" });
    expect((await edit(cookie, ticket.id, { statusId: statusId("Investigate") })).status).toBe(200);
    expect((await edit(cookie, ticket.id, { statusId: statusId("Triage") })).status).toBe(200);

    expect((await removeStatus(cookie, project.id, statusId("Investigate"))).status).toBe(200);
    expect(await ticketsIn(cookie, project.id, statusId("Triage"))).toEqual(["Moving on"]);
  });

  test("renaming, moving or changing the kind of a Status that holds Tickets leaves them in it", async () => {
    const { cookie, project, statusId } = await newProject();
    const ticket = await createTicket(cookie, project.id, { title: "Staying put" });
    expect((await edit(cookie, ticket.id, { statusId: statusId("Ready") })).status).toBe(200);

    for (const body of [{ name: "Todo" }, { position: 0 }, { kind: "active" }]) {
      const changed = await cronk.request("PATCH", `/api/projects/${project.id}/statuses/${statusId("Ready")}`, {
        cookie,
        body,
      });
      expect(changed.status, JSON.stringify(body)).toBe(200);
      expect(await ticketsIn(cookie, project.id, statusId("Ready")), JSON.stringify(body)).toEqual(["Staying put"]);
    }
  });
});

describe("listing and filtering Tickets", () => {
  async function fourTickets() {
    const context = await newProject();
    const { user, cookie, project, statusId } = context;
    const make = async (title: string, body: Record<string, unknown>) => {
      const ticket = await createTicket(cookie, project.id, { title });
      expect((await edit(cookie, ticket.id, body)).status).toBe(200);
    };
    await make("Urgent bug", { priority: "urgent", labels: ["Bug"], assigneeId: user.id });
    await make("Ready feature", { statusId: statusId("Ready"), labels: ["feature", "ui"] });
    await make("Done bug", { statusId: statusId("Done"), labels: ["bug", "UI"], assigneeId: user.id });
    await make("Plain", {});
    const titles = async (query: string) => {
      const response = await cronk.request("GET", `/api/projects/${project.id}/tickets${query}`, { cookie });
      expect(response.status, query).toBe(200);
      return (await response.json()).map((t: { title: string }) => t.title);
    };
    return { ...context, titles };
  }

  test("a Project's Tickets are listed in board order, then by key", async () => {
    const { titles } = await fourTickets();
    expect(await titles("")).toEqual(["Urgent bug", "Plain", "Ready feature", "Done bug"]);
  });

  test("Tickets are filtered by Status, Assignee, Priority and Label, all at once", async () => {
    const { user, statusId, titles } = await fourTickets();

    expect(await titles(`?statusId=${statusId("Ready")}`)).toEqual(["Ready feature"]);
    expect(await titles(`?assigneeId=${user.id}`)).toEqual(["Urgent bug", "Done bug"]);
    expect(await titles("?assigneeId=none")).toEqual(["Plain", "Ready feature"]);
    expect(await titles("?priority=urgent")).toEqual(["Urgent bug"]);
    expect(await titles("?priority=none")).toEqual(["Plain", "Ready feature", "Done bug"]);
    expect(await titles(`?label=BUG&assigneeId=${user.id}&statusId=${statusId("Done")}`)).toEqual(["Done bug"]);
  });

  test("a Label filter matches ignoring case", async () => {
    const { titles } = await fourTickets();
    expect(await titles("?label=bug")).toEqual(["Urgent bug", "Done bug"]);
    expect(await titles("?label=Ui")).toEqual(["Ready feature", "Done bug"]);
  });

  test("an unknown Priority filter is refused", async () => {
    const { cookie, project } = await fourTickets();
    const response = await cronk.request("GET", `/api/projects/${project.id}/tickets?priority=critical`, { cookie });
    expect(response.status).toBe(400);
  });
});

describe("Comments", () => {
  const comment = (cookie: string, ticketId: string, body: Record<string, unknown>) =>
    cronk.request("POST", `/api/tickets/${ticketId}/comments`, { cookie, body });

  test("a User comments on a Ticket and replies to a Comment", async () => {
    const { user, cookie, project } = await newProject();
    const ticket = await createTicket(cookie, project.id, { title: "Discuss" });

    const first = await comment(cookie, ticket.id, { body: "Shall we use **SSE**?" });
    expect(first.status).toBe(201);
    const question = await first.json();
    expect(question).toEqual({
      id: expect.any(String),
      ticketId: ticket.id,
      replyToId: null,
      body: "Shall we use **SSE**?",
      actor: { kind: "user", id: user.id, name: user.email },
      createdAt: "2026-01-01T09:00:00.000Z",
      mentions: [],
    });

    cronk.clock.advance(60_000);
    const second = await comment(cookie, ticket.id, { body: "Yes.", replyToId: question.id });
    expect(second.status).toBe(201);
    const reply = await second.json();
    expect(reply).toMatchObject({ replyToId: question.id, body: "Yes.", createdAt: "2026-01-01T09:01:00.000Z" });

    const listed = await cronk.request("GET", `/api/tickets/${ticket.id}/comments`, { cookie });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual([question, reply]);
  });

  test("Comments made at the same instant are listed in the order they were made", async () => {
    const { cookie, project } = await newProject();
    const ticket = await createTicket(cookie, project.id, { title: "Busy" });
    const bodies = ["one", "two", "three", "four", "five", "six", "seven", "eight"];
    for (const body of bodies) expect((await comment(cookie, ticket.id, { body })).status).toBe(201);

    const listed = await (await cronk.request("GET", `/api/tickets/${ticket.id}/comments`, { cookie })).json();
    expect(listed.map((c: { body: string }) => c.body)).toEqual(bodies);
  });

  test("a reply to a Comment on another Ticket is refused", async () => {
    const { cookie, project } = await newProject();
    const one = await createTicket(cookie, project.id, { title: "One" });
    const two = await createTicket(cookie, project.id, { title: "Two" });
    const elsewhere = await (await comment(cookie, one.id, { body: "Over here" })).json();

    for (const replyToId of [elsewhere.id, "00000000-0000-4000-8000-000000000000"]) {
      const response = await comment(cookie, two.id, { body: "Reply", replyToId });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: { code: "unknown_comment", message: "Replies go to a Comment on the same Ticket." },
      });
    }
  });

  test("a blank Comment is refused, and Comments on a Ticket the User can't see answer 404", async () => {
    const { cookie, project } = await newProject();
    const ticket = await createTicket(cookie, project.id, { title: "Quiet" });

    expect((await comment(cookie, ticket.id, { body: "  " })).status).toBe(400);
    const missing = "00000000-0000-4000-8000-000000000000";
    expect((await comment(cookie, missing, { body: "Hello" })).status).toBe(404);
    expect((await cronk.request("GET", `/api/tickets/${missing}/comments`, { cookie })).status).toBe(404);
  });
});

describe("the Ticket's timeline", () => {
  const timeline = async (cookie: string, ticketId: string) => {
    const response = await cronk.request("GET", `/api/tickets/${ticketId}/timeline`, { cookie });
    expect(response.status).toBe(200);
    return response.json();
  };

  test("every Change shows its Actor, its time, and what it was before and after", async () => {
    const { user, cookie, project, statusId } = await newProject();
    const ada = { kind: "user", id: user.id, name: user.email };
    const ticket = await createTicket(cookie, project.id, { title: "Draft", description: "First" });

    cronk.clock.advance(60_000);
    await edit(cookie, ticket.id, {
      title: "Final",
      description: "Second",
      priority: "low",
      labels: ["bug"],
      assigneeId: user.id,
      dueDate: "2026-03-01",
      estimate: 2,
    });
    cronk.clock.advance(60_000);
    await edit(cookie, ticket.id, { statusId: statusId("Ready"), assigneeId: null, estimate: null });

    const at = (minute: number) => `2026-01-01T09:0${minute}:00.000Z`;
    const assignee = { id: user.id, name: user.email };
    expect(await timeline(cookie, ticket.id)).toEqual([
      { id: expect.any(String), actor: ada, runId: null, at: at(0), field: "created", from: null, to: null },
      { id: expect.any(String), actor: ada, runId: null, at: at(1), field: "title", from: "Draft", to: "Final" },
      { id: expect.any(String), actor: ada, runId: null, at: at(1), field: "description", from: "First", to: "Second" },
      { id: expect.any(String), actor: ada, runId: null, at: at(1), field: "priority", from: "none", to: "low" },
      { id: expect.any(String), actor: ada, runId: null, at: at(1), field: "labels", from: [], to: ["bug"] },
      { id: expect.any(String), actor: ada, runId: null, at: at(1), field: "assignee", from: null, to: assignee },
      { id: expect.any(String), actor: ada, runId: null, at: at(1), field: "dueDate", from: null, to: "2026-03-01" },
      { id: expect.any(String), actor: ada, runId: null, at: at(1), field: "estimate", from: null, to: 2 },
      {
        id: expect.any(String),
        actor: ada,
        runId: null,
        at: at(2),
        field: "status",
        from: { id: statusId("Backlog"), name: "Backlog" },
        to: { id: statusId("Ready"), name: "Ready" },
      },
      { id: expect.any(String), actor: ada, runId: null, at: at(2), field: "assignee", from: assignee, to: null },
      { id: expect.any(String), actor: ada, runId: null, at: at(2), field: "estimate", from: 2, to: null },
    ]);
  });

  test("an edit that changes nothing adds no Change", async () => {
    const { cookie, project } = await newProject();
    const ticket = await createTicket(cookie, project.id, { title: "Same" });

    await edit(cookie, ticket.id, { title: "Same", priority: "none", labels: [], statusId: ticket.statusId });

    expect((await timeline(cookie, ticket.id)).map((c: { field: string }) => c.field)).toEqual(["created"]);
  });

  test("the timeline of a Ticket the User can't see answers 404", async () => {
    const { cookie } = await newProject();
    const response = await cronk.request("GET", "/api/tickets/00000000-0000-4000-8000-000000000000/timeline", {
      cookie,
    });
    expect(response.status).toBe(404);
  });
});

describe("Ticket keys in Markdown", () => {
  test("keys of Tickets in the Workspace are mentions, whatever the case they're written in", async () => {
    const { workspace, cookie, project } = await newProject();
    const ops = await createProject(cookie, workspace.id, "Operations", "OPS");
    const one = await createTicket(cookie, project.id, { title: "One" });
    const opsOne = await createTicket(cookie, ops.id, { title: "Ops one" });

    const ticket = await createTicket(cookie, project.id, {
      title: "Mentions",
      description: "After CRONK-1 and ops-1, again CRONK-1; not CRONK-9, NOPE-1, XCRONK-1 or CRONK-1x.",
    });

    expect(ticket.mentions).toEqual([
      { text: "CRONK-1", key: "CRONK-1", ticketId: one.id },
      { text: "ops-1", key: "OPS-1", ticketId: opsOne.id },
    ]);
    expect((await (await cronk.request("GET", `/api/tickets/${ticket.id}`, { cookie })).json()).mentions).toEqual(
      ticket.mentions,
    );
    const edited = await (await edit(cookie, ticket.id, { description: "Only CRONK-2 now" })).json();
    expect(edited.mentions).toEqual([{ text: "CRONK-2", key: "CRONK-2", ticketId: ticket.id }]);
  });

  test("keys in a Comment are mentions", async () => {
    const { cookie, project } = await newProject();
    const one = await createTicket(cookie, project.id, { title: "One" });

    const response = await cronk.request("POST", `/api/tickets/${one.id}/comments`, {
      cookie,
      body: { body: "Same as CRONK-1, unlike CRONK-2." },
    });

    expect((await response.json()).mentions).toEqual([{ text: "CRONK-1", key: "CRONK-1", ticketId: one.id }]);
  });
});
