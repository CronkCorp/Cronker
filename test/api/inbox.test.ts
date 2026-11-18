import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openEvents, type EventStream } from "../harness/events.js";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

let cronk: StartedCronk;
beforeEach(async () => {
  cronk = await startCronk();
});
const streams: EventStream[] = [];
afterEach(async () => {
  for (const stream of streams.splice(0)) stream.close();
  await cronk?.stop();
});

interface Project {
  id: string;
  statuses: { id: string; name: string; kind: string }[];
}

/** Ada's Workspace with a Project on the default board, and Bea as a second member. */
async function workspaceWithProject() {
  const { user: ada, workspace } = await setUp(cronk);
  const adaCookie = await signIn(cronk);
  const created = await cronk.request("POST", `/api/workspaces/${workspace.id}/projects`, {
    cookie: adaCookie,
    body: { name: "Cronker", key: "CRONK" },
  });
  expect(created.status).toBe(201);
  const project = (await created.json()) as Project;
  const bea = await addMember(cronk, adaCookie, workspace.id, "bea@example.com");
  const statusId = (name: string) => project.statuses.find((s) => s.name === name)!.id;
  return { ada: { ...ada, cookie: adaCookie }, bea: { ...bea.user, cookie: bea.cookie }, workspace, project, statusId };
}

async function createTicket(cookie: string, projectId: string, title: string) {
  const response = await cronk.request("POST", `/api/projects/${projectId}/tickets`, { cookie, body: { title } });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; key: string };
}

async function editTicket(cookie: string, ticketId: string, body: Record<string, unknown>) {
  const response = await cronk.request("PATCH", `/api/tickets/${ticketId}`, { cookie, body });
  expect(response.status).toBe(200);
}

async function inbox(cookie: string, workspaceId: string) {
  const response = await cronk.request("GET", `/api/workspaces/${workspaceId}/inbox`, { cookie });
  expect(response.status).toBe(200);
  return response.json();
}

describe("Tickets waiting for review", () => {
  test("a Ticket in a Review Status appears in its Assignee's Inbox and nobody else's", async () => {
    const { ada, bea, workspace, project, statusId } = await workspaceWithProject();
    const ticket = await createTicket(ada.cookie, project.id, "Check the Inbox");
    await createTicket(ada.cookie, project.id, "Not in review yet");
    await editTicket(ada.cookie, ticket.id, { statusId: statusId("In Review"), assigneeId: bea.id });

    expect(await inbox(bea.cookie, workspace.id)).toEqual({
      count: 1,
      items: [
        {
          kind: "review",
          ticket: expect.objectContaining({ id: ticket.id, key: "CRONK-1", title: "Check the Inbox" }),
          status: { id: statusId("In Review"), name: "In Review" },
        },
      ],
    });
    expect(await inbox(ada.cookie, workspace.id)).toEqual({ count: 0, items: [] });
  });

  test("moving the Ticket out of its Review Status removes it from the Inbox at once", async () => {
    const { ada, workspace, project, statusId } = await workspaceWithProject();
    const ticket = await createTicket(ada.cookie, project.id, "Reviewed");
    await editTicket(ada.cookie, ticket.id, { statusId: statusId("In Review"), assigneeId: ada.id });
    expect((await inbox(ada.cookie, workspace.id)).count).toBe(1);

    await editTicket(ada.cookie, ticket.id, { statusId: statusId("Done") });

    expect(await inbox(ada.cookie, workspace.id)).toEqual({ count: 0, items: [] });
  });

  test("changing the Assignee moves the Ticket to the new Assignee's Inbox at once", async () => {
    const { ada, bea, workspace, project, statusId } = await workspaceWithProject();
    const ticket = await createTicket(ada.cookie, project.id, "Handed over");
    await editTicket(ada.cookie, ticket.id, { statusId: statusId("In Review"), assigneeId: ada.id });

    await editTicket(ada.cookie, ticket.id, { assigneeId: bea.id });

    expect(await inbox(ada.cookie, workspace.id)).toEqual({ count: 0, items: [] });
    expect((await inbox(bea.cookie, workspace.id)).items).toEqual([
      expect.objectContaining({ kind: "review", ticket: expect.objectContaining({ id: ticket.id }) }),
    ]);

    await editTicket(ada.cookie, ticket.id, { assigneeId: null });

    expect(await inbox(bea.cookie, workspace.id)).toEqual({ count: 0, items: [] });
  });

  test("changing a Status's kind away from Review removes its Tickets from the Inbox", async () => {
    const { ada, workspace, project, statusId } = await workspaceWithProject();
    const ticket = await createTicket(ada.cookie, project.id, "Waiting");
    await editTicket(ada.cookie, ticket.id, { statusId: statusId("Code review"), assigneeId: ada.id });
    expect((await inbox(ada.cookie, workspace.id)).count).toBe(0);

    const edited = await cronk.request("PATCH", `/api/projects/${project.id}/statuses/${statusId("Code review")}`, {
      cookie: ada.cookie,
      body: { kind: "review" },
    });
    expect(edited.status).toBe(200);
    expect((await inbox(ada.cookie, workspace.id)).count).toBe(1);

    await cronk.request("PATCH", `/api/projects/${project.id}/statuses/${statusId("Code review")}`, {
      cookie: ada.cookie,
      body: { kind: "active" },
    });
    expect((await inbox(ada.cookie, workspace.id)).count).toBe(0);
  });

  test("a Ticket assigned to the User but not in a Review Status is not in their Inbox", async () => {
    const { ada, workspace, project, statusId } = await workspaceWithProject();
    const ticket = await createTicket(ada.cookie, project.id, "Being worked on");
    await editTicket(ada.cookie, ticket.id, { statusId: statusId("Implement"), assigneeId: ada.id });

    expect(await inbox(ada.cookie, workspace.id)).toEqual({ count: 0, items: [] });
  });
});

describe("one Inbox per Workspace", () => {
  test("a User's Inbox in one Workspace holds nothing from their other Workspaces", async () => {
    const { ada, workspace, project, statusId } = await workspaceWithProject();
    const ticket = await createTicket(ada.cookie, project.id, "In the first Workspace");
    await editTicket(ada.cookie, ticket.id, { statusId: statusId("In Review"), assigneeId: ada.id });
    const second = await cronk.request("POST", "/api/workspaces", { cookie: ada.cookie, body: { name: "Second" } });
    expect(second.status).toBe(201);
    const { id: secondId } = (await second.json()) as { id: string };

    expect(await inbox(ada.cookie, secondId)).toEqual({ count: 0, items: [] });
    expect((await inbox(ada.cookie, workspace.id)).count).toBe(1);
  });

  test("the Inbox of a Workspace the User doesn't belong to answers as if it didn't exist", async () => {
    const { ada, bea } = await workspaceWithProject();
    const created = await cronk.request("POST", "/api/workspaces", { cookie: bea.cookie, body: { name: "Bea's" } });
    const { id: beasId } = (await created.json()) as { id: string };

    for (const workspaceId of [beasId, "not-an-id"]) {
      const response = await cronk.request("GET", `/api/workspaces/${workspaceId}/inbox`, { cookie: ada.cookie });
      expect(response.status).toBe(404);
    }
    expect((await cronk.request("GET", `/api/workspaces/${beasId}/inbox`)).status).toBe(401);
  });
});

describe("the Inbox count, live", () => {
  async function events(workspaceId: string, cookie: string) {
    const stream = await openEvents(cronk, workspaceId, cookie);
    streams.push(stream);
    return stream;
  }

  test("a client's stream starts with its User's Inbox count and gets the new count when it changes", async () => {
    const { ada, workspace, project, statusId } = await workspaceWithProject();
    const ticket = await createTicket(ada.cookie, project.id, "Watch me");
    const stream = await events(workspace.id, ada.cookie);
    expect(await stream.next()).toEqual({ event: "inbox", data: { count: 0 } });

    await editTicket(ada.cookie, ticket.id, { statusId: statusId("In Review"), assigneeId: ada.id });
    expect(await stream.next()).toEqual({ event: "inbox", data: { count: 1 } });

    await editTicket(ada.cookie, ticket.id, { statusId: statusId("Done") });
    expect(await stream.next()).toEqual({ event: "inbox", data: { count: 0 } });
  });

  test("a change that leaves a User's Inbox as it was sends that User nothing", async () => {
    const { ada, bea, workspace, project, statusId } = await workspaceWithProject();
    const adas = await createTicket(ada.cookie, project.id, "Ada's");
    const beas = await createTicket(ada.cookie, project.id, "Bea's");
    const stream = await events(workspace.id, bea.cookie);
    expect(await stream.next()).toEqual({ event: "inbox", data: { count: 0 } });

    await editTicket(ada.cookie, adas.id, { statusId: statusId("In Review"), assigneeId: ada.id });
    await editTicket(ada.cookie, adas.id, { title: "Ada's, renamed" });
    await editTicket(ada.cookie, beas.id, { statusId: statusId("In Review"), assigneeId: bea.id });

    expect(await stream.next()).toEqual({ event: "inbox", data: { count: 1 } });
  });

  test("a change to an item already in the Inbox is sent too, so the Inbox page can show it", async () => {
    const { ada, workspace, project, statusId } = await workspaceWithProject();
    const ticket = await createTicket(ada.cookie, project.id, "Old title");
    await editTicket(ada.cookie, ticket.id, { statusId: statusId("In Review"), assigneeId: ada.id });
    const stream = await events(workspace.id, ada.cookie);
    expect(await stream.next()).toEqual({ event: "inbox", data: { count: 1 } });

    await editTicket(ada.cookie, ticket.id, { title: "New title" });

    expect(await stream.next()).toEqual({ event: "inbox", data: { count: 1 } });
  });

  test("changing a Status's kind updates the count", async () => {
    const { ada, workspace, project, statusId } = await workspaceWithProject();
    const ticket = await createTicket(ada.cookie, project.id, "Waiting");
    await editTicket(ada.cookie, ticket.id, { statusId: statusId("Code review"), assigneeId: ada.id });
    const stream = await events(workspace.id, ada.cookie);
    expect(await stream.next()).toEqual({ event: "inbox", data: { count: 0 } });

    await cronk.request("PATCH", `/api/projects/${project.id}/statuses/${statusId("Code review")}`, {
      cookie: ada.cookie,
      body: { kind: "review" },
    });

    expect(await stream.next()).toEqual({ event: "inbox", data: { count: 1 } });
  });

  test("a stream carries nothing from the User's other Workspaces", async () => {
    const { ada, workspace, project, statusId } = await workspaceWithProject();
    const created = await cronk.request("POST", "/api/workspaces", { cookie: ada.cookie, body: { name: "Second" } });
    const second = (await created.json()) as { id: string };
    const secondProject = (await (
      await cronk.request("POST", `/api/workspaces/${second.id}/projects`, {
        cookie: ada.cookie,
        body: { name: "Other", key: "OTHER" },
      })
    ).json()) as Project;
    const stream = await events(second.id, ada.cookie);
    expect(await stream.next()).toEqual({ event: "inbox", data: { count: 0 } });

    const first = await createTicket(ada.cookie, project.id, "In the first Workspace");
    await editTicket(ada.cookie, first.id, { statusId: statusId("In Review"), assigneeId: ada.id });
    const other = await createTicket(ada.cookie, secondProject.id, "In the second Workspace");
    const otherReview = secondProject.statuses.find((s) => s.kind === "review")!.id;
    await editTicket(ada.cookie, other.id, { statusId: otherReview, assigneeId: ada.id });
    await editTicket(ada.cookie, other.id, { assigneeId: null });

    expect(await stream.next()).toEqual({ event: "inbox", data: { count: 1 } });
    expect(await stream.next()).toEqual({ event: "inbox", data: { count: 0 } });
  });

  test("only members may open a Workspace's stream, and removing a member ends theirs", async () => {
    const { ada, bea, workspace } = await workspaceWithProject();
    const created = await cronk.request("POST", "/api/workspaces", { cookie: bea.cookie, body: { name: "Bea's" } });
    const beas = (await created.json()) as { id: string };
    await expect(openEvents(cronk, beas.id, ada.cookie)).rejects.toMatchObject({ status: 404 });
    await expect(openEvents(cronk, workspace.id, "")).rejects.toMatchObject({ status: 401 });

    const stream = await events(workspace.id, bea.cookie);
    expect(await stream.next()).toEqual({ event: "inbox", data: { count: 0 } });
    const removed = await cronk.request("DELETE", `/api/workspaces/${workspace.id}/members/${bea.id}`, {
      cookie: ada.cookie,
    });
    expect(removed.status).toBe(204);

    await stream.ended();
  });
});
