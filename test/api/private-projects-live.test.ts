import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";
import { openStream as open, type OpenStream } from "../harness/stream.js";

/**
 * Private Projects, live (ADR 0010): a Workspace's event stream tells each User only of Projects they can read, and
 * an Access change tells those who gain or lose a Project, so their open pages add or drop it.
 */

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

interface As {
  cookie?: string;
  headers?: Record<string, string>;
}

async function call(method: string, path: string, as: As, body?: unknown) {
  const response = await cronk.request(method, path, { ...as, body });
  return { status: response.status, json: response.status === 204 ? null : await response.json() };
}

async function ok(method: string, path: string, as: As, body?: unknown) {
  const response = await call(method, path, as, body);
  expect(response.status, `${method} ${path}: ${JSON.stringify(response.json)}`).toBeLessThan(300);
  return response.json;
}

/**
 * Ada, the Admin; Grace and Linus, members who aren't Admins; a Project SECRET that Ada made private, listing Grace,
 * and an open Project OPEN.
 */
async function withSecret() {
  const { workspace, user } = await setUp(cronk);
  const ada = { id: user.id, cookie: await signIn(cronk) };
  const grace = await addMember(cronk, ada.cookie, workspace.id, "grace@example.com");
  const linus = await addMember(cronk, ada.cookie, workspace.id, "linus@example.com");
  const secret = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Secret", key: "SECRET" });
  const openProject = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Open", key: "OPEN" });
  await ok("PUT", `/api/projects/${secret.id}/access`, ada, {
    visibility: "private",
    users: [{ userId: grace.user.id, level: "write" }],
  });
  const streamOf = async (cookie: string) => {
    const stream = await open(cronk, cookie, workspace.id);
    streams.push(stream);
    return stream;
  };
  return { workspace, ada, grace, linus, secret, open: openProject, streamOf };
}

/** The next `count` events of a stream, then nothing more. */
async function events(stream: OpenStream, count: number) {
  const got = [];
  for (let i = 0; i < count; i++) got.push(await stream.next());
  await stream.expectQuiet();
  return got;
}

describe("a Workspace's event stream with a private Project", () => {
  test("tells of changes in it only its listed Users and the Admins", async () => {
    const { ada, grace, linus, secret, streamOf } = await withSecret();
    const [adas, graces, linuses] = [await streamOf(ada.cookie), await streamOf(grace.cookie), await streamOf(linus.cookie)];

    const ticket = await ok("POST", `/api/projects/${secret.id}/tickets`, ada, { title: "Hidden plans" });
    await ok("PATCH", `/api/tickets/${ticket.id}`, grace, { title: "Hidden plans, renamed" });
    const comment = await ok("POST", `/api/tickets/${ticket.id}/comments`, ada, { body: "Not for everyone." });
    const document = await ok("POST", `/api/projects/${secret.id}/documents`, ada, { title: "Plan" });
    await ok("PATCH", `/api/projects/${secret.id}`, ada, { agentsMayMerge: true });

    const expected = [
      { type: "ticket.created", data: { projectId: secret.id, ticketId: ticket.id } },
      { type: "ticket.changed", data: { projectId: secret.id, ticketId: ticket.id } },
      { type: "comment.added", data: { projectId: secret.id, ticketId: ticket.id, commentId: comment.id } },
      { type: "document.changed", data: { projectId: secret.id, documentId: document.id } },
      { type: "project.changed", data: { projectId: secret.id } },
    ];
    expect(await events(adas, expected.length)).toEqual(expected);
    expect(await events(graces, expected.length)).toEqual(expected);
    await linuses.expectQuiet();
  });

  test("tells everyone of changes in an open Project and in the Workspace's own knowledge", async () => {
    const { workspace, ada, grace, linus, open, streamOf } = await withSecret();
    const all = [await streamOf(ada.cookie), await streamOf(grace.cookie), await streamOf(linus.cookie)];

    const ticket = await ok("POST", `/api/projects/${open.id}/tickets`, linus, { title: "Out in the open" });
    const document = await ok("POST", `/api/workspaces/${workspace.id}/documents`, linus, { title: "Handbook" });

    for (const stream of all) {
      expect(await events(stream, 2)).toEqual([
        { type: "ticket.created", data: { projectId: open.id, ticketId: ticket.id } },
        { type: "document.changed", data: { projectId: null, documentId: document.id } },
      ]);
    }
  });

  test("tells of a file attached to a Document in it only those who can read the Project", async () => {
    const { workspace, ada, grace, linus, secret, streamOf } = await withSecret();
    const hidden = await ok("POST", `/api/projects/${secret.id}/documents`, ada, { title: "Plan" });
    const handbook = await ok("POST", `/api/workspaces/${workspace.id}/documents`, ada, { title: "Handbook" });
    const [graces, linuses] = [await streamOf(grace.cookie), await streamOf(linus.cookie)];
    const attach = (documentId: string) =>
      fetch(new URL(`/api/documents/${documentId}/attachments?name=notes.txt`, cronk.url), {
        method: "POST",
        headers: { cookie: ada.cookie, "content-type": "text/plain" },
        body: "notes",
      }).then((response) => expect(response.status).toBe(201));

    await attach(hidden.id);
    await attach(handbook.id);

    expect(await events(graces, 2)).toEqual([
      { type: "attachments.changed", data: { documentId: hidden.id } },
      { type: "attachments.changed", data: { documentId: handbook.id } },
    ]);
    expect(await events(linuses, 1)).toEqual([{ type: "attachments.changed", data: { documentId: handbook.id } }]);
  });

  test("tells of a session's Transcript naming a Ticket in it only those who can read the Ticket, and its Agent's Owner", async () => {
    const { workspace, ada, grace, linus, secret, streamOf } = await withSecret();
    await ok("POST", `/api/projects/${secret.id}/tickets`, ada, { title: "Hidden plans" });
    const agent = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
    const { secret: token } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "hook", access: "full" });
    const [adas, graces, linuses] = [await streamOf(ada.cookie), await streamOf(grace.cookie), await streamOf(linus.cookie)];

    const response = await fetch(`${cronk.url}/api/transcripts/sessions/laptop-1`, {
      method: "PUT",
      headers: { "content-type": "application/x-ndjson", authorization: `Bearer ${token}` },
      body:
        [
          { type: "user", uuid: "u-1", timestamp: "2026-01-01T09:00:01.000Z", message: { role: "user", content: "Read SECRET-1." } },
          {
            type: "assistant",
            uuid: "t-1",
            timestamp: "2026-01-01T09:00:02.000Z",
            message: {
              id: "msg-2",
              role: "assistant",
              content: [{ type: "tool_use", id: "t1", name: "mcp__cronk__read_ticket", input: { ticket: "SECRET-1" } }],
            },
          },
        ]
          .map((line) => JSON.stringify(line))
          .join("\n") + "\n",
    });
    expect(response.status).toBeLessThan(300);
    const transcript = await response.json();

    const changed = { type: "transcript.changed", data: { transcriptId: transcript.id, runId: null } };
    expect(await events(adas, 2)).toContainEqual(changed);
    expect(await events(graces, 2)).toContainEqual(changed);
    await linuses.expectQuiet();
  });
});

describe("an Access change, live", () => {
  test("making a Project private tells the Users it leaves out that they lost it, and nothing of it after", async () => {
    const { workspace, ada, grace, linus, open, streamOf } = await withSecret();
    const [adas, graces, linuses] = [await streamOf(ada.cookie), await streamOf(grace.cookie), await streamOf(linus.cookie)];

    await ok("PUT", `/api/projects/${open.id}/access`, ada, {
      visibility: "private",
      users: [{ userId: grace.user.id, level: "write" }],
    });
    await ok("POST", `/api/projects/${open.id}/tickets`, ada, { title: "Now private" });

    const changed = { type: "project.changed", data: { projectId: open.id } };
    expect(await events(adas, 2)).toEqual([changed, expect.objectContaining({ type: "ticket.created" })]);
    expect(await events(graces, 2)).toEqual([changed, expect.objectContaining({ type: "ticket.created" })]);
    expect(await events(linuses, 1)).toEqual([{ type: "project.lost", data: { projectId: open.id } }]);
  });

  test("listing a User on a private Project tells them they gained it, and of its changes after", async () => {
    const { ada, grace, linus, secret, streamOf } = await withSecret();
    const [graces, linuses] = [await streamOf(grace.cookie), await streamOf(linus.cookie)];

    await ok("PUT", `/api/projects/${secret.id}/access`, ada, {
      visibility: "private",
      users: [
        { userId: grace.user.id, level: "write" },
        { userId: linus.user.id, level: "write" },
      ],
    });
    const ticket = await ok("POST", `/api/projects/${secret.id}/tickets`, ada, { title: "Shared now" });

    const created = { type: "ticket.created", data: { projectId: secret.id, ticketId: ticket.id } };
    expect(await events(linuses, 2)).toEqual([{ type: "project.gained", data: { projectId: secret.id } }, created]);
    expect(await events(graces, 2)).toEqual([{ type: "project.changed", data: { projectId: secret.id } }, created]);
  });

  test("removing a listed User tells them they lost it; making it open tells the unlisted they gained it", async () => {
    const { ada, grace, linus, secret, streamOf } = await withSecret();
    const [adas, graces, linuses] = [await streamOf(ada.cookie), await streamOf(grace.cookie), await streamOf(linus.cookie)];

    await ok("PUT", `/api/projects/${secret.id}/access`, ada, { visibility: "private", users: [] });
    await ok("PUT", `/api/projects/${secret.id}/access`, ada, { visibility: "open", users: [] });

    const changed = { type: "project.changed", data: { projectId: secret.id } };
    expect(await events(adas, 2)).toEqual([changed, changed]);
    expect(await events(graces, 2)).toEqual([
      { type: "project.lost", data: { projectId: secret.id } },
      { type: "project.gained", data: { projectId: secret.id } },
    ]);
    expect(await events(linuses, 1)).toEqual([{ type: "project.gained", data: { projectId: secret.id } }]);
  });

  test("a refused Access change tells nobody", async () => {
    const { ada, grace, linus, secret, streamOf } = await withSecret();
    const all = [await streamOf(ada.cookie), await streamOf(grace.cookie), await streamOf(linus.cookie)];

    const refused = await call("PUT", `/api/projects/${secret.id}/access`, grace, { visibility: "open", users: [] });

    expect(refused.status).toBe(403);
    for (const stream of all) await stream.expectQuiet();
  });
});
