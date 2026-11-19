import { afterEach, describe, expect, test } from "vitest";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { openStream } from "../harness/stream.js";
import { startCronk, type StartCronkOptions, type StartedCronk } from "../harness/start-cronk.js";

let cronk: StartedCronk;
afterEach(async () => {
  await cronk?.stop();
});

async function start(options: StartCronkOptions = {}) {
  cronk = await startCronk(options);
}

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

/** Sends a file's bytes as the request body, as the web client does, named in the query. */
async function upload(path: string, as: As, file: { name: string; type: string; bytes: Uint8Array | string }) {
  const response = await fetch(new URL(`${path}?name=${encodeURIComponent(file.name)}`, cronk.url), {
    method: "POST",
    headers: { ...as.headers, ...(as.cookie ? { cookie: as.cookie } : {}), "content-type": file.type },
    body: file.bytes as BodyInit,
  });
  return { status: response.status, json: await response.json() };
}

async function attached(path: string, as: As, file: { name: string; type: string; bytes: Uint8Array | string }) {
  const response = await upload(path, as, file);
  expect(response.status, `POST ${path}: ${JSON.stringify(response.json)}`).toBe(201);
  return response.json;
}

const download = (id: string, as: As) =>
  fetch(new URL(`/api/attachments/${id}/content`, cronk.url), {
    headers: { ...as.headers, ...(as.cookie ? { cookie: as.cookie } : {}) },
  });

const log = { name: "build.log", type: "text/plain", bytes: "npm test\n42 passed\n" };

/** Ada's Workspace with a Project CRONK, a Ticket CRONK-1 and a full token of her Agent `claude-max`. */
async function workspaceWithTicket() {
  const { workspace, user } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Make it so" });
  const agent = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "laptop", access: "full" });
  const asAgent = { headers: { authorization: `Bearer ${secret}` } };
  return { workspace, user, ada, project, ticket, agent, asAgent };
}

describe("Attachments on a Ticket", () => {
  test("a User attaches a file to a Ticket, finds it listed with the Ticket and downloads it as it was", async () => {
    await start();
    const { ada, user, ticket } = await workspaceWithTicket();

    const attachment = await attached(`/api/tickets/${ticket.id}/attachments`, ada, log);

    expect(attachment).toEqual({
      id: expect.any(String),
      name: "build.log",
      mediaType: "text/plain",
      size: 19,
      on: { kind: "ticket", id: ticket.id },
      actor: { kind: "user", id: user.id, name: "ada@example.com" },
      createdAt: "2026-01-01T09:00:00.000Z",
    });
    expect(await ok("GET", `/api/tickets/${ticket.id}/attachments`, ada)).toEqual([attachment]);
    const downloaded = await download(attachment.id, ada);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("content-disposition")).toBe(`attachment; filename="build.log"; filename*=UTF-8''build.log`);
    expect(await downloaded.text()).toBe("npm test\n42 passed\n");
  });
});

describe("the size limit", () => {
  test("a file over the configured limit is refused naming the limit, and nothing is kept", async () => {
    await start({ attachmentLimitBytes: 1024 });
    const { ada, ticket } = await workspaceWithTicket();

    const refused = await upload(`/api/tickets/${ticket.id}/attachments`, ada, {
      name: "huge.log",
      type: "text/plain",
      bytes: "x".repeat(1025),
    });

    expect(refused.status).toBe(413);
    expect(refused.json.error).toEqual(
      expect.objectContaining({ code: "attachment_too_large", message: "An Attachment may be at most 1 KB." }),
    );
    expect(await ok("GET", `/api/tickets/${ticket.id}/attachments`, ada)).toEqual([]);
    expect(await cronk.attachmentFiles()).toEqual([]);
  });

  test("a file exactly at the limit is attached", async () => {
    await start({ attachmentLimitBytes: 1024 });
    const { ada, ticket } = await workspaceWithTicket();

    const attachment = await attached(`/api/tickets/${ticket.id}/attachments`, ada, {
      name: "full.log",
      type: "text/plain",
      bytes: "x".repeat(1024),
    });

    expect(attachment.size).toBe(1024);
    expect(await cronk.attachmentFiles()).toEqual([attachment.id]);
  });

  test("by default the limit is 25 MB", async () => {
    await start();
    const { ada, ticket } = await workspaceWithTicket();

    const refused = await upload(`/api/tickets/${ticket.id}/attachments`, ada, {
      name: "huge.bin",
      type: "application/octet-stream",
      bytes: new Uint8Array(25 * 1024 * 1024 + 1),
    });

    expect(refused.status).toBe(413);
    expect(refused.json.error.message).toBe("An Attachment may be at most 25 MB.");
  });
});

describe("never active content on Cronk's origin", () => {
  test("an HTML or SVG file downloads as plain bytes, sandboxed, never as a page", async () => {
    await start();
    const { ada, ticket } = await workspaceWithTicket();

    for (const file of [
      { name: "page.html", type: "text/html", bytes: "<script>fetch('/api/me')</script>" },
      { name: "logo.svg", type: "image/svg+xml", bytes: "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>" },
    ]) {
      const attachment = await attached(`/api/tickets/${ticket.id}/attachments`, ada, file);
      expect(attachment.mediaType).toBe(file.type);

      const downloaded = await download(attachment.id, ada);
      expect(downloaded.headers.get("content-type")).toBe("application/octet-stream");
      expect(downloaded.headers.get("content-disposition")).toMatch(/^attachment;/);
      expect(downloaded.headers.get("x-content-type-options")).toBe("nosniff");
      expect(downloaded.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    }
  });

  test("a picture keeps its media type, so Markdown can show it", async () => {
    await start();
    const { ada, ticket } = await workspaceWithTicket();
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const attachment = await attached(`/api/tickets/${ticket.id}/attachments`, ada, { name: "board.png", type: "image/png", bytes: png });

    const downloaded = await download(attachment.id, ada);
    expect(downloaded.headers.get("content-type")).toBe("image/png");
    expect(downloaded.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(png);
  });

  test("a name outside ASCII is kept, and saved under it", async () => {
    await start();
    const { ada, ticket } = await workspaceWithTicket();

    const attachment = await attached(`/api/tickets/${ticket.id}/attachments`, ada, { ...log, name: 'résumé "final".txt' });

    expect(attachment.name).toBe('résumé "final".txt');
    expect((await download(attachment.id, ada)).headers.get("content-disposition")).toBe(
      `attachment; filename="r_sum_ _final_.txt"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22.txt`,
    );
  });
});

describe("access follows what it's attached to", () => {
  test("another member of the Workspace reads and downloads it", async () => {
    await start();
    const { ada, workspace, ticket } = await workspaceWithTicket();
    const attachment = await attached(`/api/tickets/${ticket.id}/attachments`, ada, log);
    const grace = await addMember(cronk, ada.cookie, workspace.id, "grace@example.com");

    expect(await ok("GET", `/api/tickets/${ticket.id}/attachments`, grace)).toEqual([attachment]);
    expect((await download(attachment.id, grace)).status).toBe(200);
  });

  test("nothing crosses Workspaces: another Workspace's User and Agent find no such Attachment and attach nothing", async () => {
    await start();
    const { ada, ticket, project } = await workspaceWithTicket();
    const attachment = await attached(`/api/tickets/${ticket.id}/attachments`, ada, log);
    const document = await ok("POST", `/api/projects/${project.id}/documents`, ada, { title: "Plan" });
    // Grace belongs only to another Workspace, where she has an Agent.
    const other = await ok("POST", "/api/workspaces", ada, { name: "Other" });
    const grace = await addMember(cronk, ada.cookie, other.id, "grace@example.com");
    const theirs = await ok("POST", `/api/workspaces/${other.id}/agents`, grace, { name: "grace-bot" });
    const { secret } = await ok("POST", `/api/agents/${theirs.id}/tokens`, grace, { name: "laptop", access: "full" });
    const graceBot = { headers: { authorization: `Bearer ${secret}` } };

    for (const outsider of [grace, graceBot]) {
      expect((await download(attachment.id, outsider)).status).toBe(404);
      expect((await call("GET", `/api/tickets/${ticket.id}/attachments`, outsider)).status).toBe(404);
      expect((await upload(`/api/tickets/${ticket.id}/attachments`, outsider, log)).status).toBe(404);
      expect((await upload(`/api/documents/${document.id}/attachments`, outsider, log)).status).toBe(404);
      expect((await call("DELETE", `/api/attachments/${attachment.id}`, outsider)).status).toBe(404);
    }
    expect(await ok("GET", `/api/tickets/${ticket.id}/attachments`, ada)).toEqual([attachment]);
  });

  test("without a sign-in or token nothing is downloaded", async () => {
    await start();
    const { ada, ticket } = await workspaceWithTicket();
    const attachment = await attached(`/api/tickets/${ticket.id}/attachments`, ada, log);

    expect((await download(attachment.id, {})).status).toBe(401);
  });
});

describe("Attachments on a Document", () => {
  test("a User and an Agent attach files to a Document of a Project or of the Workspace", async () => {
    await start();
    const { ada, asAgent, agent, project, workspace } = await workspaceWithTicket();
    const projectDocument = await ok("POST", `/api/projects/${project.id}/documents`, ada, { title: "Plan" });
    const workspaceDocument = await ok("POST", `/api/workspaces/${workspace.id}/documents`, ada, { title: "Handbook" });

    const byAda = await attached(`/api/documents/${projectDocument.id}/attachments`, ada, log);
    const byAgent = await attached(`/api/documents/${workspaceDocument.id}/attachments`, asAgent, { ...log, name: "agent.log" });

    expect(byAda.on).toEqual({ kind: "document", id: projectDocument.id });
    expect(byAgent).toEqual(
      expect.objectContaining({
        on: { kind: "document", id: workspaceDocument.id },
        actor: { kind: "agent", id: agent.id, name: "claude-max" },
      }),
    );
    expect(await ok("GET", `/api/documents/${workspaceDocument.id}/attachments`, ada)).toEqual([byAgent]);
  });

  test("deleting a Document removes what is attached to it, files included", async () => {
    await start();
    const { ada, project } = await workspaceWithTicket();
    const document = await ok("POST", `/api/projects/${project.id}/documents`, ada, { title: "Plan" });
    const attachment = await attached(`/api/documents/${document.id}/attachments`, ada, log);

    expect((await call("DELETE", `/api/documents/${document.id}`, ada)).status).toBe(204);

    expect((await download(attachment.id, ada)).status).toBe(404);
    expect(await cronk.attachmentFiles()).toEqual([]);
  });
});

describe("Attachments on a Comment", () => {
  test("a Comment's author attaches files to it, and the Ticket's Comments carry them", async () => {
    await start();
    const { ada, asAgent, ticket } = await workspaceWithTicket();
    const adas = await ok("POST", `/api/tickets/${ticket.id}/comments`, ada, { body: "See the log." });
    const agents = await ok("POST", `/api/tickets/${ticket.id}/comments`, asAgent, { body: "And mine." });

    const onAdas = await attached(`/api/comments/${adas.id}/attachments`, ada, log);
    const onAgents = await attached(`/api/comments/${agents.id}/attachments`, asAgent, { ...log, name: "agent.log" });

    expect(onAdas.on).toEqual({ kind: "comment", id: adas.id });
    expect(await ok("GET", `/api/comments/${agents.id}/attachments`, ada)).toEqual([onAgents]);
    const comments = await ok("GET", `/api/tickets/${ticket.id}/comments`, ada);
    expect(comments.map((c: { attachments: unknown }) => c.attachments)).toEqual([[onAdas], [onAgents]]);
  });

  test("nobody attaches to, or removes from, another Actor's Comment", async () => {
    await start();
    const { ada, asAgent, ticket } = await workspaceWithTicket();
    const adas = await ok("POST", `/api/tickets/${ticket.id}/comments`, ada, { body: "See the log." });
    const agents = await ok("POST", `/api/tickets/${ticket.id}/comments`, asAgent, { body: "And mine." });
    const onAdas = await attached(`/api/comments/${adas.id}/attachments`, ada, log);

    const byAgent = await upload(`/api/comments/${adas.id}/attachments`, asAgent, log);
    const byAda = await upload(`/api/comments/${agents.id}/attachments`, ada, log);
    const removedByAgent = await call("DELETE", `/api/attachments/${onAdas.id}`, asAgent);

    for (const refused of [byAgent, byAda, removedByAgent]) {
      expect(refused.status).toBe(403);
      expect(refused.json.error.code).toBe("not_comment_author");
    }
    expect(byAgent.json.error).toEqual(expect.objectContaining({ rule: expect.any(String), advice: expect.any(String) }));
  });
});

describe("removing an Attachment", () => {
  test("a User removes an Attachment: it is no longer listed or downloaded, and its file is gone", async () => {
    await start();
    const { ada, ticket } = await workspaceWithTicket();
    const kept = await attached(`/api/tickets/${ticket.id}/attachments`, ada, { ...log, name: "kept.log" });
    const removed = await attached(`/api/tickets/${ticket.id}/attachments`, ada, log);

    expect((await call("DELETE", `/api/attachments/${removed.id}`, ada)).status).toBe(204);

    expect(await ok("GET", `/api/tickets/${ticket.id}/attachments`, ada)).toEqual([kept]);
    expect((await download(removed.id, ada)).status).toBe(404);
    expect(await cronk.attachmentFiles()).toEqual([kept.id]);
  });
});

describe("an Agent's write rights", () => {
  /** Ada's Agent `claude-max` running a Triage Run on CRONK-1, through her fake Runner. */
  async function runningRun() {
    const setup = await workspaceWithTicket();
    const { ada, project, ticket, agent } = setup;
    const runner = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
    await ok("PATCH", `/api/agents/${agent.id}`, ada, { runnerId: runner.id });
    const triage = project.statuses.find((s: { name: string }) => s.name === "Triage").id;
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: triage });
    return setup;
  }

  test("an Agent attaches to a Ticket during its running Run on it, and removes what it attached", async () => {
    await start();
    const { ada, ticket, asAgent } = await runningRun();
    const adas = await attached(`/api/tickets/${ticket.id}/attachments`, ada, { ...log, name: "ada.log" });

    const attachment = await attached(`/api/tickets/${ticket.id}/attachments`, asAgent, log);
    expect(attachment.actor.name).toBe("claude-max");

    const removingAdas = await call("DELETE", `/api/attachments/${adas.id}`, asAgent);
    expect(removingAdas.status).toBe(403);
    expect(removingAdas.json.error.code).toBe("agent_not_allowed");
    expect((await call("DELETE", `/api/attachments/${attachment.id}`, asAgent)).status).toBe(204);
    expect(await ok("GET", `/api/tickets/${ticket.id}/attachments`, ada)).toEqual([adas]);
  });

  test("outside a running Run on the Ticket, an Agent attaches nothing to it", async () => {
    await start();
    const { ticket, asAgent } = await workspaceWithTicket();

    const refused = await upload(`/api/tickets/${ticket.id}/attachments`, asAgent, log);

    expect(refused.status).toBe(403);
    expect(refused.json.error).toEqual(
      expect.objectContaining({ code: "no_running_run", rule: expect.any(String), advice: expect.any(String) }),
    );
  });

  test("a read-only token reads and downloads Attachments but attaches and removes nothing", async () => {
    await start();
    const { ada, ticket, project, agent } = await workspaceWithTicket();
    const document = await ok("POST", `/api/projects/${project.id}/documents`, ada, { title: "Plan" });
    const attachment = await attached(`/api/documents/${document.id}/attachments`, ada, log);
    const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "reader", access: "read" });
    const reader = { headers: { authorization: `Bearer ${secret}` } };

    expect(await ok("GET", `/api/documents/${document.id}/attachments`, reader)).toEqual([attachment]);
    expect((await download(attachment.id, reader)).status).toBe(200);
    expect((await upload(`/api/documents/${document.id}/attachments`, reader, log)).json.error.code).toBe("read_only_token");
    expect((await call("DELETE", `/api/attachments/${attachment.id}`, reader)).json.error.code).toBe("read_only_token");
    expect((await upload(`/api/tickets/${ticket.id}/attachments`, reader, log)).status).toBe(403);
  });
});

describe("live updates", () => {
  test("attaching and removing tell the Workspace which Ticket or Document changed", async () => {
    await start();
    const { ada, workspace, project, ticket } = await workspaceWithTicket();
    const document = await ok("POST", `/api/workspaces/${workspace.id}/documents`, ada, { title: "Handbook" });
    const comment = await ok("POST", `/api/tickets/${ticket.id}/comments`, ada, { body: "See the log." });
    const stream = await openStream(cronk, ada.cookie, workspace.id);

    const onTicket = await attached(`/api/tickets/${ticket.id}/attachments`, ada, log);
    expect(await stream.next()).toEqual({ type: "attachments.changed", data: { projectId: project.id, ticketId: ticket.id } });
    await attached(`/api/comments/${comment.id}/attachments`, ada, log);
    expect(await stream.next()).toEqual({ type: "attachments.changed", data: { projectId: project.id, ticketId: ticket.id } });
    await attached(`/api/documents/${document.id}/attachments`, ada, log);
    expect(await stream.next()).toEqual({ type: "attachments.changed", data: { documentId: document.id } });
    await ok("DELETE", `/api/attachments/${onTicket.id}`, ada);
    expect(await stream.next()).toEqual({ type: "attachments.changed", data: { projectId: project.id, ticketId: ticket.id } });
  });
});
