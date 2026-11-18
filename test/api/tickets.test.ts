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
      dueDate: null,
      estimate: null,
      createdBy: user.id,
      createdAt: "2026-01-01T09:00:00.000Z",
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

  test("a Status that holds Tickets can't be removed until they move out", async () => {
    const { cookie, project, statusId } = await newProject();
    const ticket = await createTicket(cookie, project.id, { title: "Ready to go" });
    await edit(cookie, ticket.id, { statusId: statusId("Ready") });

    const refused = await cronk.request("DELETE", `/api/projects/${project.id}/statuses/${statusId("Ready")}`, {
      cookie,
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: { code: "status_has_tickets", message: "Ready still holds Tickets. Move them to another Status first." },
    });

    await edit(cookie, ticket.id, { statusId: statusId("Backlog") });
    const removed = await cronk.request("DELETE", `/api/projects/${project.id}/statuses/${statusId("Ready")}`, {
      cookie,
    });
    expect(removed.status).toBe(200);
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
