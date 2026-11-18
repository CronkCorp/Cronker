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
