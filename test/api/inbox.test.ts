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

  test("a Ticket assigned to the User but not in a Review Status is not in their Inbox", async () => {
    const { ada, workspace, project, statusId } = await workspaceWithProject();
    const ticket = await createTicket(ada.cookie, project.id, "Being worked on");
    await editTicket(ada.cookie, ticket.id, { statusId: statusId("Implement"), assigneeId: ada.id });

    expect(await inbox(ada.cookie, workspace.id)).toEqual({ count: 0, items: [] });
  });
});
