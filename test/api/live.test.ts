import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { days } from "../harness/clock.js";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";
import { openStream as open, type OpenStream } from "../harness/stream.js";

let cronk: StartedCronk;
let streams: OpenStream[];
beforeEach(async () => {
  cronk = await startCronk();
  streams = [];
});
afterEach(async () => {
  for (const stream of streams) stream.close();
  await cronk?.stop();
});

async function openStream(cookie: string, workspaceId: string) {
  const stream = await open(cronk, cookie, workspaceId);
  streams.push(stream);
  return stream;
}

interface Project {
  id: string;
  statuses: { id: string; name: string }[];
}

async function newProject() {
  const { user, workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const response = await cronk.request("POST", `/api/workspaces/${workspace.id}/projects`, {
    cookie,
    body: { name: "Cronker", key: "CRONK" },
  });
  expect(response.status).toBe(201);
  const project = (await response.json()) as Project;
  const statusId = (name: string) => project.statuses.find((s) => s.name === name)!.id;
  return { user, workspace, cookie, project, statusId };
}

async function createTicket(cookie: string, projectId: string, title: string) {
  const response = await cronk.request("POST", `/api/projects/${projectId}/tickets`, { cookie, body: { title } });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string };
}

describe("a Workspace's event stream", () => {
  test("tells about a created Ticket", async () => {
    const { workspace, cookie, project } = await newProject();
    const stream = await openStream(cookie, workspace.id);

    const ticket = await createTicket(cookie, project.id, "Live");

    expect(await stream.next()).toEqual({
      type: "ticket.created",
      data: { projectId: project.id, ticketId: ticket.id },
    });
  });

  test("tells about a Ticket edited or moved, and not about an edit that changes nothing", async () => {
    const { workspace, cookie, project, statusId } = await newProject();
    const ticket = await createTicket(cookie, project.id, "Live");
    const stream = await openStream(cookie, workspace.id);

    for (const body of [{ title: "Renamed" }, { title: "Renamed" }, { statusId: statusId("Ready") }]) {
      const response = await cronk.request("PATCH", `/api/tickets/${ticket.id}`, { cookie, body });
      expect(response.status).toBe(200);
    }

    const changed = { type: "ticket.changed", data: { projectId: project.id, ticketId: ticket.id } };
    expect(await stream.next()).toEqual(changed);
    expect(await stream.next()).toEqual(changed);
    await stream.expectQuiet();
  });

  test("tells about both Tickets of a Relation added or removed, and each parent a Sub-Ticket leaves or joins", async () => {
    const { workspace, cookie, project } = await newProject();
    const [one, two, three] = [
      await createTicket(cookie, project.id, "One"),
      await createTicket(cookie, project.id, "Two"),
      await createTicket(cookie, project.id, "Three"),
    ];
    await cronk.request("PATCH", `/api/tickets/${three.id}`, { cookie, body: { parentId: one.id } });
    const stream = await openStream(cookie, workspace.id);
    const changed = (ticket: { id: string }) => ({
      type: "ticket.changed",
      data: { projectId: project.id, ticketId: ticket.id },
    });

    const added = await cronk.request("POST", `/api/tickets/${one.id}/relations`, {
      cookie,
      body: { kind: "blocks", ticketId: two.id },
    });
    expect(added.status).toBe(201);
    expect([await stream.next(), await stream.next()]).toEqual([changed(one), changed(two)]);

    const removed = await cronk.request("DELETE", `/api/tickets/${two.id}/relations/${(await added.json()).id}`, {
      cookie,
    });
    expect(removed.status).toBe(204);
    expect([await stream.next(), await stream.next()]).toEqual([changed(one), changed(two)]);

    await cronk.request("PATCH", `/api/tickets/${three.id}`, { cookie, body: { parentId: two.id } });
    expect([await stream.next(), await stream.next(), await stream.next()]).toEqual([
      changed(three),
      changed(one),
      changed(two),
    ]);
    await stream.expectQuiet();
  });

  test("tells about a Comment and a reply", async () => {
    const { workspace, cookie, project } = await newProject();
    const ticket = await createTicket(cookie, project.id, "Discuss");
    const stream = await openStream(cookie, workspace.id);

    const comment = async (body: unknown) => {
      const response = await cronk.request("POST", `/api/tickets/${ticket.id}/comments`, { cookie, body });
      expect(response.status).toBe(201);
      return (await response.json()) as { id: string };
    };
    const first = await comment({ body: "Why?" });
    const reply = await comment({ body: "Because.", replyToId: first.id });

    for (const added of [first, reply]) {
      expect(await stream.next()).toEqual({
        type: "comment.added",
        data: { projectId: project.id, ticketId: ticket.id, commentId: added.id },
      });
    }
  });

  test("tells about a Status added, edited or removed", async () => {
    const { workspace, cookie, project } = await newProject();
    const stream = await openStream(cookie, workspace.id);
    const statuses = `/api/projects/${project.id}/statuses`;

    const added = await cronk.request("POST", statuses, { cookie, body: { name: "Waiting", kind: "backlog" } });
    expect(added.status).toBe(201);
    const waiting = ((await added.json()) as Project).statuses.find((s) => s.name === "Waiting")!;
    const edited = await cronk.request("PATCH", `${statuses}/${waiting.id}`, { cookie, body: { position: 0 } });
    expect(edited.status).toBe(200);
    expect((await cronk.request("DELETE", `${statuses}/${waiting.id}`, { cookie })).status).toBe(200);

    for (let i = 0; i < 3; i++) {
      expect(await stream.next()).toEqual({ type: "statuses.changed", data: { projectId: project.id } });
    }
  });

  test("tells about a Project created with its Statuses", async () => {
    const { workspace, cookie } = await newProject();
    const stream = await openStream(cookie, workspace.id);

    const response = await cronk.request("POST", `/api/workspaces/${workspace.id}/projects`, {
      cookie,
      body: { name: "Operations", key: "OPS" },
    });
    expect(response.status).toBe(201);

    const project = (await response.json()) as Project;
    expect(await stream.next()).toEqual({ type: "project.created", data: { projectId: project.id } });
  });

  test("tells about a Document created, saved, moved or deleted, in the Workspace's page tree or a Project's", async () => {
    const { workspace, cookie, project } = await newProject();
    const stream = await openStream(cookie, workspace.id);
    const create = async (path: string, title: string) => {
      const response = await cronk.request("POST", path, { cookie, body: { title, body: "Draft" } });
      expect(response.status).toBe(201);
      return (await response.json()) as { id: string };
    };

    const guide = await create(`/api/workspaces/${workspace.id}/documents`, "Guide");
    const plan = await create(`/api/projects/${project.id}/documents`, "Plan");
    const saved = await cronk.request("PATCH", `/api/documents/${guide.id}`, { cookie, body: { baseVersion: 1, body: "Done" } });
    expect(saved.status).toBe(200);
    const moved = await cronk.request("PATCH", `/api/documents/${plan.id}`, { cookie, body: { position: 0 } });
    expect(moved.status).toBe(200);
    expect((await cronk.request("DELETE", `/api/documents/${guide.id}`, { cookie })).status).toBe(204);

    const inWorkspace = { type: "document.changed", data: { projectId: null, documentId: guide.id } };
    const inProject = { type: "document.changed", data: { projectId: project.id, documentId: plan.id } };
    for (const expected of [inWorkspace, inProject, inWorkspace, inProject, inWorkspace]) {
      expect(await stream.next()).toEqual(expected);
    }
  });

  test("tells about a Term created, saved or deleted, in the Workspace's glossary or a Project's", async () => {
    const { workspace, cookie, project } = await newProject();
    const stream = await openStream(cookie, workspace.id);
    const create = async (path: string, name: string) => {
      const response = await cronk.request("POST", path, { cookie, body: { name, definition: "What it means." } });
      expect(response.status).toBe(201);
      return (await response.json()) as { id: string };
    };

    const ticket = await create(`/api/workspaces/${workspace.id}/terms`, "Ticket");
    const run = await create(`/api/projects/${project.id}/terms`, "Run");
    const saved = await cronk.request("PATCH", `/api/terms/${run.id}`, { cookie, body: { baseVersion: 1, definition: "One go." } });
    expect(saved.status).toBe(200);
    expect((await cronk.request("DELETE", `/api/terms/${ticket.id}`, { cookie })).status).toBe(204);

    const inWorkspace = { type: "term.changed", data: { projectId: null, termId: ticket.id } };
    const inProject = { type: "term.changed", data: { projectId: project.id, termId: run.id } };
    for (const expected of [inWorkspace, inProject, inProject, inWorkspace]) {
      expect(await stream.next()).toEqual(expected);
    }
  });

  test("tells about a Decision recorded or saved, in the Workspace's register or a Project's, and not about a save that changes nothing", async () => {
    const { workspace, cookie, project } = await newProject();
    const stream = await openStream(cookie, workspace.id);
    const record = async (path: string, title: string) => {
      const response = await cronk.request("POST", path, { cookie, body: { title, body: "Why." } });
      expect(response.status).toBe(201);
      return (await response.json()) as { id: string };
    };

    const postgres = await record(`/api/workspaces/${workspace.id}/decisions`, "Use Postgres");
    const events = await record(`/api/projects/${project.id}/decisions`, "Server-sent events");
    for (const body of [{ baseVersion: 1, status: "accepted" }, { baseVersion: 2, status: "accepted" }]) {
      expect((await cronk.request("PATCH", `/api/decisions/${events.id}`, { cookie, body })).status).toBe(200);
    }

    const inWorkspace = { type: "decision.changed", data: { projectId: null, decisionId: postgres.id } };
    const inProject = { type: "decision.changed", data: { projectId: project.id, decisionId: events.id } };
    for (const expected of [inWorkspace, inProject, inProject]) {
      expect(await stream.next()).toEqual(expected);
    }
    await stream.expectQuiet();
  });

  test("tells nothing of a change that was refused", async () => {
    const { workspace, cookie, project, statusId } = await newProject();
    const ticket = await createTicket(cookie, project.id, "Stay put");
    const stream = await openStream(cookie, workspace.id);

    const refused = [
      cronk.request("PATCH", `/api/tickets/${ticket.id}`, {
        cookie,
        body: { title: "Half done", assigneeId: "00000000-0000-4000-8000-000000000000" },
      }),
      cronk.request("DELETE", `/api/projects/${project.id}/statuses/${statusId("Backlog")}`, { cookie }),
      cronk.request("POST", `/api/tickets/${ticket.id}/comments`, {
        cookie,
        body: { body: "To nothing", replyToId: "00000000-0000-4000-8000-000000000000" },
      }),
      cronk.request("POST", `/api/workspaces/${workspace.id}/projects`, { cookie, body: { name: "Again", key: "CRONK" } }),
    ];
    for (const response of await Promise.all(refused)) expect(response.status).toBeGreaterThanOrEqual(400);
    await stream.expectQuiet();

    expect((await cronk.request("PATCH", `/api/tickets/${ticket.id}`, { cookie, body: { title: "Now" } })).status).toBe(200);
    expect(await stream.next()).toMatchObject({ type: "ticket.changed" });
  });
});

describe("Workspaces apart", () => {
  test("a stream carries nothing from another Workspace, even one its User belongs to", async () => {
    const { workspace, cookie, project } = await newProject();
    const created = await cronk.request("POST", "/api/workspaces", { cookie, body: { name: "Side project" } });
    expect(created.status).toBe(201);
    const other = (await created.json()) as { id: string };
    const otherStream = await openStream(cookie, other.id);
    const stream = await openStream(cookie, workspace.id);

    const ticket = await createTicket(cookie, project.id, "Only here");

    expect(await stream.next()).toMatchObject({ type: "ticket.created", data: { ticketId: ticket.id } });
    await otherStream.expectQuiet();
  });

  test("the stream of a Workspace the User doesn't belong to answers 404, and without a sign-in 401", async () => {
    const { workspace } = await newProject();
    const created = await cronk.request("POST", "/api/workspaces", {
      cookie: await signIn(cronk),
      body: { name: "Private" },
    });
    const { id: privateId } = (await created.json()) as { id: string };
    const bob = await addMember(cronk, await signIn(cronk), workspace.id, "bob@example.com");

    for (const id of [privateId, "00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
      const response = await cronk.request("GET", `/api/workspaces/${id}/events`, { cookie: bob.cookie });
      expect(response.status, id).toBe(404);
    }
    expect((await cronk.request("GET", `/api/workspaces/${workspace.id}/events`)).status).toBe(401);
  });

  test("a member's stream ends when they are removed from the Workspace", async () => {
    const { workspace, cookie, project } = await newProject();
    const bob = await addMember(cronk, cookie, workspace.id, "bob@example.com");
    const stream = await openStream(bob.cookie, workspace.id);
    const adaStream = await openStream(cookie, workspace.id);

    const removed = await cronk.request("DELETE", `/api/workspaces/${workspace.id}/members/${bob.user.id}`, { cookie });
    expect(removed.status).toBe(204);
    await stream.ended();

    await createTicket(cookie, project.id, "After Bob left");
    expect(await adaStream.next()).toMatchObject({ type: "ticket.created" });
  });

  test("a stream ends when the sign-in it was opened with signs out", async () => {
    const { workspace, cookie } = await newProject();
    const otherSignIn = await signIn(cronk);
    const stream = await openStream(cookie, workspace.id);
    const stillOpen = await openStream(otherSignIn, workspace.id);

    expect((await cronk.request("DELETE", "/api/sign-in", { cookie })).status).toBe(204);

    await stream.ended();
    await expect(stillOpen.ended(300)).rejects.toThrow("still open");
  });

  test("a stream carries nothing once its sign-in has expired, and ends", async () => {
    const { workspace, cookie, project } = await newProject();
    const stream = await openStream(cookie, workspace.id);

    cronk.clock.advance(days(30));
    await createTicket(await signIn(cronk), project.id, "After the sign-in ran out");

    await stream.ended();
  });

  test("changing a password ends the streams of the User's other sign-ins", async () => {
    const { workspace, cookie } = await newProject();
    const otherSignIn = await signIn(cronk);
    const kept = await openStream(cookie, workspace.id);
    const other = await openStream(otherSignIn, workspace.id);

    const changed = await cronk.request("PUT", "/api/me/password", {
      cookie,
      body: { currentPassword: "correct horse battery", newPassword: "another horse battery" },
    });
    expect(changed.status).toBe(204);

    await other.ended();
    await expect(kept.ended(300)).rejects.toThrow("still open");
  });
});
