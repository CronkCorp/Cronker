import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { hours } from "../harness/clock.js";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";
import { openStream, type OpenStream } from "../harness/stream.js";

let cronk: StartedCronk;
beforeEach(async () => {
  cronk = await startCronk();
});
const streams: OpenStream[] = [];
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
          report: null,
          since: "2026-01-01T09:00:00.000Z",
        },
      ],
    });
    expect(await inbox(ada.cookie, workspace.id)).toEqual({ count: 0, items: [] });
  });

  test("a Ticket waiting for review carries the time it entered its Review Status", async () => {
    const { ada, workspace, project, statusId } = await workspaceWithProject();
    const ticket = await createTicket(ada.cookie, project.id, "Check the time");
    cronk.clock.advance(hours(2));
    await editTicket(ada.cookie, ticket.id, { statusId: statusId("In Review"), assigneeId: ada.id });
    cronk.clock.advance(hours(1));
    await editTicket(ada.cookie, ticket.id, { title: "Check the time again" });

    expect((await inbox(ada.cookie, workspace.id)).items).toEqual([
      expect.objectContaining({ kind: "review", since: "2026-01-01T11:00:00.000Z" }),
    ]);
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

describe("the latest Report on a Ticket to review or verify", () => {
  /** An Agent of Ada's on a fake Runner, writing Reports and finishing its running Run on a Ticket. */
  async function agentOf(cookie: string, workspaceId: string) {
    const call = async (method: string, path: string, body: unknown) => (await cronk.request(method, path, { cookie, body })).json();
    const runner = await call("POST", "/api/runners", { name: "Fake", kind: "fake" });
    const agent = await call("POST", `/api/workspaces/${workspaceId}/agents`, { name: "claude-max" });
    await call("PATCH", `/api/agents/${agent.id}`, { runnerId: runner.id });
    const { secret } = await call("POST", `/api/agents/${agent.id}/tokens`, { name: "cloud", access: "full" });
    const headers = { authorization: `Bearer ${secret}` };
    const report = async (ticketId: string, title: string) =>
      expect((await cronk.request("POST", `/api/tickets/${ticketId}/reports`, { headers, body: { title, body: "…" } })).status).toBe(201);
    const finish = async (ticketId: string, outcome: string) => {
      const runs = await (await cronk.request("GET", `/api/tickets/${ticketId}/runs`, { cookie })).json();
      const running = runs.find((r: { state: string }) => r.state === "running");
      expect((await cronk.request("POST", `/api/runs/${running.id}/finish`, { headers, body: { outcome } })).status).toBe(200);
    };
    return { agent, report, finish };
  }

  test("a Ticket waiting for review carries its latest Report, for the Inbox to show its title", async () => {
    const { ada, workspace, project, statusId } = await workspaceWithProject();
    const { agent, report, finish } = await agentOf(ada.cookie, workspace.id);
    const ticket = await createTicket(ada.cookie, project.id, "Cache the board");
    await editTicket(ada.cookie, ticket.id, { delegateId: agent.id, statusId: statusId("Code review") });
    await report(ticket.id, "First look");
    await report(ticket.id, "Code review report");
    await finish(ticket.id, "approve");

    const [item] = (await inbox(ada.cookie, workspace.id)).items;
    expect(item).toMatchObject({ kind: "review", report: { id: expect.any(String), title: "Code review report" } });
  });

  test("an Unverified completion carries its latest Report, and an item without one carries none", async () => {
    const { ada, workspace, project, statusId } = await workspaceWithProject();
    const { agent, report, finish } = await agentOf(ada.cookie, workspace.id);
    const completed = await createTicket(ada.cookie, project.id, "Ship the export");
    await editTicket(ada.cookie, completed.id, { delegateId: agent.id, autonomousDelegation: true, statusId: statusId("Code review") });
    await report(completed.id, "Export report");
    await finish(completed.id, "complete");
    const unreported = await createTicket(ada.cookie, project.id, "Check by hand");
    await editTicket(ada.cookie, unreported.id, { statusId: statusId("In Review"), assigneeId: ada.id });

    const { items } = await inbox(ada.cookie, workspace.id);
    const of = (ticketId: string) => items.find((i: { ticket: { id: string } }) => i.ticket.id === ticketId);
    expect(of(completed.id)).toMatchObject({ kind: "unverified", report: { title: "Export report" } });
    expect(of(unreported.id)).toMatchObject({ kind: "review", report: null });
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

describe("the Inbox, live", () => {
  async function events(workspaceId: string, cookie: string) {
    const stream = await openStream(cronk, cookie, workspaceId);
    streams.push(stream);
    return stream;
  }

  test("moving a Ticket into or out of a User's Inbox is told on the stream, and their Inbox then shows it", async () => {
    const { ada, workspace, project, statusId } = await workspaceWithProject();
    const ticket = await createTicket(ada.cookie, project.id, "Watch me");
    const stream = await events(workspace.id, ada.cookie);

    await editTicket(ada.cookie, ticket.id, { statusId: statusId("In Review"), assigneeId: ada.id });
    expect(await stream.next()).toEqual({
      type: "ticket.changed",
      data: { projectId: project.id, ticketId: ticket.id },
    });
    expect((await inbox(ada.cookie, workspace.id)).count).toBe(1);

    await editTicket(ada.cookie, ticket.id, { statusId: statusId("Done") });
    expect(await stream.next()).toEqual({
      type: "ticket.changed",
      data: { projectId: project.id, ticketId: ticket.id },
    });
    expect((await inbox(ada.cookie, workspace.id)).count).toBe(0);
  });

  test("changing a Status's kind is told on the stream, and the Inbox then shows its Tickets", async () => {
    const { ada, workspace, project, statusId } = await workspaceWithProject();
    const ticket = await createTicket(ada.cookie, project.id, "Waiting");
    await editTicket(ada.cookie, ticket.id, { statusId: statusId("Code review"), assigneeId: ada.id });
    const stream = await events(workspace.id, ada.cookie);

    await cronk.request("PATCH", `/api/projects/${project.id}/statuses/${statusId("Code review")}`, {
      cookie: ada.cookie,
      body: { kind: "review" },
    });

    expect(await stream.next()).toEqual({ type: "statuses.changed", data: { projectId: project.id } });
    expect((await inbox(ada.cookie, workspace.id)).count).toBe(1);
  });
});

describe("an archived Project's Tickets", () => {
  test("leave the Inbox while it is archived, and those still waiting come back when it is unarchived, told live", async () => {
    const { ada, workspace, project, statusId } = await workspaceWithProject();
    const request = async (method: string, path: string, as: { cookie?: string; headers?: Record<string, string> }, body?: unknown) => {
      const response = await cronk.request(method, path, { ...as, body });
      expect(response.status, `${method} ${path}`).toBeLessThan(300);
      return response.json();
    };
    const runner = await request("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
    const agent = await request("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
    await request("PATCH", `/api/agents/${agent.id}`, ada, { runnerId: runner.id });
    const { secret } = await request("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "cloud", access: "full" });
    const asAgent = { headers: { authorization: `Bearer ${secret}` } };

    const review = await createTicket(ada.cookie, project.id, "Check by hand");
    await editTicket(ada.cookie, review.id, { statusId: statusId("In Review"), assigneeId: ada.id });
    const asked = await createTicket(ada.cookie, project.id, "Pick a colour");
    await editTicket(ada.cookie, asked.id, { delegateId: agent.id, statusId: statusId("Investigate") });
    const [run] = await request("GET", `/api/tickets/${asked.id}/runs`, ada);
    await request("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "needs you", question: "Blue or green?" });
    const discovered = await request("POST", `/api/projects/${project.id}/tickets`, asAgent, { title: "Found on the way" });
    // A Ticket of another Project stays put.
    const other = await request("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Other", key: "OTHER" });
    const elsewhere = await createTicket(ada.cookie, other.id, "Elsewhere");
    const inReview = other.statuses.find((s: { name: string }) => s.name === "In Review").id;
    await editTicket(ada.cookie, elsewhere.id, { statusId: inReview, assigneeId: ada.id });

    const waiting = (inbox: { items: { kind: string; ticket: { id: string } }[] }) =>
      inbox.items.map((item) => [item.kind, item.ticket.id]).sort();
    const before = waiting(await inbox(ada.cookie, workspace.id));
    expect(before).toEqual(
      [
        ["review", review.id],
        ["question", asked.id],
        ["needsYou", asked.id],
        ["discovered", discovered.id],
        ["review", elsewhere.id],
      ].sort(),
    );

    const stream = await openStream(cronk, ada.cookie, workspace.id);
    streams.push(stream);
    await request("POST", `/api/projects/${project.id}/archive`, ada);
    expect(await stream.next()).toEqual({ type: "project.changed", data: { projectId: project.id } });
    expect(await inbox(ada.cookie, workspace.id)).toEqual({
      count: 1,
      items: [expect.objectContaining({ kind: "review", ticket: expect.objectContaining({ id: elsewhere.id }) })],
    });

    await request("POST", `/api/projects/${project.id}/unarchive`, ada);
    expect(await stream.next()).toEqual({ type: "project.changed", data: { projectId: project.id } });
    expect(waiting(await inbox(ada.cookie, workspace.id))).toEqual(before);
  });
});
