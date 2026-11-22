import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, test } from "vitest";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

/**
 * Private Projects (ADR 0010): an Admin makes a Project private and lists who may see it, and everyone else, with
 * their Agents, finds nothing of its board, Tickets, knowledge and Artifacts, as if they were records of another
 * Workspace.
 */

let cronk: StartedCronk;
const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
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

async function agentOf(as: As, workspaceId: string, name: string) {
  const agent = await ok("POST", `/api/workspaces/${workspaceId}/agents`, as, { name });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, as, { name: "laptop", access: "full" });
  return { ...agent, secret: secret as string, as: { headers: { authorization: `Bearer ${secret}` } } };
}

async function connect(token: string) {
  const client = new Client({ name: "cronk-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", cronk.url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function tool(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const [content] = result.content as { type: string; text: string }[];
  return { isError: result.isError ?? false, text: content!.text };
}

/**
 * Ada, the Admin, with a Project SECRET and an open Project OPEN; Grace and Linus, members who aren't Admins, each
 * with an Agent. SECRET-1, assigned to Grace in a Review Status, has a Comment and a Sub-Ticket SECRET-2, blocks
 * OPEN-1 and relates to OPEN-2. OPEN-1 mentions SECRET-1 in its description and was filed from it.
 */
async function twoProjects() {
  cronk = await startCronk();
  const { workspace, user } = await setUp(cronk);
  const ada = { id: user.id, cookie: await signIn(cronk) };
  const grace = await addMember(cronk, ada.cookie, workspace.id, "grace@example.com");
  const linus = await addMember(cronk, ada.cookie, workspace.id, "linus@example.com");
  const secret = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Secret", key: "SECRET" });
  const open = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Open", key: "OPEN" });
  const review = secret.statuses.find((s: { kind: string }) => s.kind === "review").id;
  const hidden = await ok("POST", `/api/projects/${secret.id}/tickets`, ada, { title: "Hidden plans" });
  await ok("PATCH", `/api/tickets/${hidden.id}`, ada, { assigneeId: grace.user.id, statusId: review });
  const sub = await ok("POST", `/api/projects/${secret.id}/tickets`, ada, { title: "Hidden part", parentId: hidden.id });
  const comment = await ok("POST", `/api/tickets/${hidden.id}/comments`, ada, { body: "Not for everyone." });
  const blocked = await ok("POST", `/api/projects/${open.id}/tickets`, ada, {
    title: "Waits on it",
    description: "After SECRET-1.",
  });
  const related = await ok("POST", `/api/projects/${open.id}/tickets`, ada, { title: "Related" });
  await ok("POST", `/api/tickets/${hidden.id}/relations`, ada, { kind: "blocks", ticketId: blocked.id });
  await ok("POST", `/api/tickets/${hidden.id}/relations`, ada, { kind: "relatesTo", ticketId: related.id });
  const adasAgent = await agentOf(ada, workspace.id, "ada-claude");
  const gracesAgent = await agentOf({ cookie: grace.cookie }, workspace.id, "grace-claude");
  const linusesAgent = await agentOf({ cookie: linus.cookie }, workspace.id, "linus-claude");
  await cronk.stage("update tickets set discovered_by_agent_id = $2, discovered_from_ticket_id = $3 where id = $1", [
    blocked.id,
    adasAgent.id,
    hidden.id,
  ]);
  const makePrivate = (users: string[] = [linus.user.id]) =>
    ok("PUT", `/api/projects/${secret.id}/access`, ada, {
      visibility: "private",
      users: users.map((userId) => ({ userId, level: "write" })),
    });
  return {
    workspace,
    ada,
    grace: { ...grace, as: { cookie: grace.cookie } },
    linus: { ...linus, as: { cookie: linus.cookie } },
    secret,
    open,
    hidden,
    sub,
    comment,
    blocked,
    related,
    adasAgent,
    gracesAgent,
    linusesAgent,
    makePrivate,
  };
}

type Setting = Awaited<ReturnType<typeof twoProjects>>;

/** Every read of the private Project's board and Tickets, by id and by key. */
function secretReads({ secret, hidden, sub }: Setting): string[] {
  return [
    `/api/projects/${secret.id}`,
    `/api/projects/SECRET`,
    `/api/projects/${secret.id}/tickets`,
    `/api/tickets/${hidden.id}`,
    `/api/tickets/SECRET-1`,
    `/api/tickets/${sub.id}`,
    `/api/tickets/${hidden.id}/comments`,
    `/api/tickets/${hidden.id}/relations`,
    `/api/tickets/${hidden.id}/timeline`,
    `/api/tickets/${hidden.id}/runs`,
    `/api/tickets/${hidden.id}/pull-requests`,
  ];
}

async function expectReads(setting: Setting, as: As, status: 200 | 404) {
  for (const path of secretReads(setting)) expect((await call("GET", path, as)).status, path).toBe(status);
}

const projectKeys = async (setting: Setting, as: As) =>
  (await ok("GET", `/api/workspaces/${setting.workspace.id}/projects`, as)).map((p: { key: string }) => p.key);

const inboxKeys = async (setting: Setting, as: As) =>
  (await ok("GET", `/api/workspaces/${setting.workspace.id}/inbox`, as)).items.map(
    (item: { ticket: { key: string } }) => item.ticket.key,
  );

describe("setting a Project's Access", () => {
  test("an Admin makes a Project private, lists Users on it and opens it again", async () => {
    const { ada, secret, linus, grace, makePrivate } = await twoProjects();
    expect(await ok("GET", `/api/projects/${secret.id}/access`, ada)).toEqual({ visibility: "open", users: [] });

    const listed = await makePrivate([linus.user.id, grace.user.id]);

    const both = [
      { userId: linus.user.id, level: "write" },
      { userId: grace.user.id, level: "write" },
    ];
    expect(listed).toEqual({ visibility: "private", users: expect.arrayContaining(both) });
    expect(await ok("GET", `/api/projects/${secret.id}/access`, ada)).toEqual(listed);
    expect((await ok("GET", `/api/projects/${secret.id}`, ada)).visibility).toBe("private");

    const opened = await ok("PUT", `/api/projects/${secret.id}/access`, ada, { visibility: "open", users: [] });
    expect(opened).toEqual({ visibility: "open", users: [] });
  });

  test("is refused to Users who aren't Admins, and to Agents", async () => {
    const { secret, grace, linus, gracesAgent, adasAgent } = await twoProjects();
    const body = { visibility: "private", users: [] };

    for (const as of [grace.as, linus.as]) {
      const read = await call("GET", `/api/projects/${secret.id}/access`, as);
      expect(read).toEqual({ status: 403, json: { error: expect.objectContaining({ code: "not_admin" }) } });
      const set = await call("PUT", `/api/projects/${secret.id}/access`, as, body);
      expect(set).toEqual({ status: 403, json: { error: expect.objectContaining({ code: "not_admin" }) } });
    }
    for (const agent of [gracesAgent, adasAgent]) {
      expect((await call("PUT", `/api/projects/${secret.id}/access`, agent.as, body)).status).toBe(403);
    }
  });

  test("lists only Users of the Project's Workspace, each once", async () => {
    const { ada, secret, linus } = await twoProjects();
    const friends = await ok("POST", "/api/workspaces", ada, { name: "Friends" });
    const outsider = await addMember(cronk, ada.cookie, friends.id, "outsider@example.com");

    const foreign = await call("PUT", `/api/projects/${secret.id}/access`, ada, {
      visibility: "private",
      users: [{ userId: outsider.user.id, level: "write" }],
    });
    expect(foreign).toEqual({ status: 400, json: { error: expect.objectContaining({ code: "unknown_user" }) } });
    const twice = await call("PUT", `/api/projects/${secret.id}/access`, ada, {
      visibility: "private",
      users: [linus.user.id, linus.user.id].map((userId) => ({ userId, level: "write" })),
    });
    expect(twice).toEqual({ status: 400, json: { error: expect.objectContaining({ code: "user_listed_twice" }) } });
    const unknownLevel = await call("PUT", `/api/projects/${secret.id}/access`, ada, {
      visibility: "private",
      users: [{ userId: linus.user.id, level: "admin" }],
    });
    expect(unknownLevel.status).toBe(400);
    expect(await ok("GET", `/api/projects/${secret.id}/access`, ada)).toEqual({ visibility: "open", users: [] });
  });

  test("Project responses carry the caller's own Access", async () => {
    const setting = await twoProjects();
    const { ada, grace, secret, workspace, gracesAgent } = setting;

    expect((await ok("GET", `/api/projects/${secret.id}`, grace.as)).access).toBe("write");
    expect(await ok("GET", `/api/workspaces/${workspace.id}/projects`, gracesAgent.as)).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "SECRET", access: "write", visibility: "open" })]),
    );
    await setting.makePrivate([]);
    expect((await ok("GET", `/api/projects/${secret.id}`, ada)).access).toBe("write");
  });
});

describe("a private Project's board and Tickets", () => {
  test("answer as not found to a User it doesn't list, and to their Agents, over the HTTP API", async () => {
    const setting = await twoProjects();
    await expectReads(setting, setting.grace.as, 200);
    await setting.makePrivate();

    for (const as of [setting.grace.as, setting.gracesAgent.as]) {
      await expectReads(setting, as, 404);
      expect(await projectKeys(setting, as)).toEqual(["OPEN"]);
    }
  });

  test("stay as before for Admins, the Users it lists and their Agents", async () => {
    const setting = await twoProjects();
    const before = await Promise.all(secretReads(setting).map((path) => ok("GET", path, setting.ada)));
    // Grace, SECRET-1's Assignee, stays listed: losing Write would unassign her (`losing-write.test.ts`).
    await setting.makePrivate([setting.linus.user.id, setting.grace.user.id]);

    for (const as of [setting.ada, setting.adasAgent.as, setting.linus.as, setting.linusesAgent.as]) {
      await expectReads(setting, as, 200);
      expect(await projectKeys(setting, as)).toEqual(["OPEN", "SECRET"]);
    }
    const after = await Promise.all(secretReads(setting).map((path) => ok("GET", path, setting.ada)));
    expect(after.slice(2)).toEqual(before.slice(2));
    for (const project of [0, 1]) expect(after[project]).toEqual({ ...before[project], visibility: "private" });
  });

  test("leave its Tickets out of the Relations, mentions and source of Tickets in other Projects", async () => {
    const setting = await twoProjects();
    const { blocked, related, grace, ada } = setting;
    const relatedKeys = async (as: As, ticketId: string) =>
      (await ok("GET", `/api/tickets/${ticketId}/relations`, as)).relations.map(
        (r: { ticket: { key: string } }) => r.ticket.key,
      );
    expect(await relatedKeys(grace.as, related.id)).toEqual(["SECRET-1"]);
    await setting.makePrivate();

    for (const as of [grace.as, setting.gracesAgent.as]) {
      expect(await relatedKeys(as, related.id)).toEqual([]);
      expect(await relatedKeys(as, blocked.id)).toEqual([]);
      const ticket = await ok("GET", `/api/tickets/${blocked.id}`, as);
      expect(ticket.mentions).toEqual([]);
      expect(ticket.discovered.sourceTicket).toBeNull();
      const timeline = await ok("GET", `/api/tickets/${blocked.id}/timeline`, as);
      expect(JSON.stringify(timeline)).not.toContain("SECRET");
    }
    const asAdmin = await ok("GET", `/api/tickets/${blocked.id}`, ada);
    expect(asAdmin.mentions.map((m: { key: string }) => m.key)).toEqual(["SECRET-1"]);
    expect(asAdmin.discovered.sourceTicket.key).toBe("SECRET-1");
    expect(await relatedKeys(ada, related.id)).toEqual(["SECRET-1"]);
  });

  test("can't be related to by a User it doesn't list, as if they weren't in the Workspace", async () => {
    const setting = await twoProjects();
    await setting.makePrivate();

    for (const body of [
      { kind: "relatesTo", ticketKey: "SECRET-1" },
      { kind: "relatesTo", ticketId: setting.hidden.id },
    ]) {
      const refused = await call("POST", `/api/tickets/${setting.related.id}/relations`, setting.grace.as, body);
      expect(refused).toEqual({ status: 400, json: { error: expect.objectContaining({ code: "unknown_ticket" }) } });
    }
    const [hiddenRelation] = (await ok("GET", `/api/tickets/${setting.related.id}/relations`, setting.ada)).relations;
    const removed = await call(
      "DELETE",
      `/api/tickets/${setting.related.id}/relations/${hiddenRelation.id}`,
      setting.grace.as,
    );
    expect(removed.status).toBe(404);
    expect((await ok("GET", `/api/tickets/${setting.related.id}/relations`, setting.ada)).relations).toHaveLength(1);
  });

  test("still count as blockers, without being named", async () => {
    const setting = await twoProjects();
    const { blocked, open, grace, ada } = setting;
    await setting.makePrivate();

    for (const as of [grace.as, setting.gracesAgent.as]) {
      const ticket = await ok("GET", `/api/tickets/${blocked.id}`, as);
      expect(ticket).toMatchObject({ blockedBy: [], blockedByHidden: 1 });
      const [listed] = (await ok("GET", `/api/projects/${open.id}/tickets`, as)).filter(
        (t: { id: string }) => t.id === blocked.id,
      );
      expect(listed).toMatchObject({ blockedBy: [], blockedByHidden: 1 });
      // Its description says "After SECRET-1." as written; nothing else names the blocker.
      expect(JSON.stringify({ ...listed, description: "" })).not.toMatch(/SECRET|Hidden plans/);
    }
    const asAdmin = await ok("GET", `/api/tickets/${blocked.id}`, ada);
    expect(asAdmin).toMatchObject({ blockedBy: [{ key: "SECRET-1", title: "Hidden plans" }], blockedByHidden: 0 });
  });

  test("leave the Inbox of a User it doesn't list, and their Tickets there wait in the Admins'", async () => {
    const setting = await twoProjects();
    expect(await inboxKeys(setting, setting.grace.as)).toEqual(["SECRET-1"]);
    expect(await inboxKeys(setting, setting.ada)).not.toContain("SECRET-1");

    await setting.makePrivate();
    expect(await inboxKeys(setting, setting.grace.as)).toEqual([]);
    expect(await inboxKeys(setting, setting.ada)).toContain("SECRET-1");

    // Losing Write unassigned her, so listing her again doesn't hand SECRET-1 back.
    await setting.makePrivate([setting.grace.user.id]);
    expect(await inboxKeys(setting, setting.grace.as)).toEqual([]);
  });

  test("answer as not found to the Agents of a User it doesn't list over MCP", async () => {
    const setting = await twoProjects();
    await setting.makePrivate();
    const graces = await connect(setting.gracesAgent.secret);
    const linuses = await connect(setting.linusesAgent.secret);

    for (const ticket of ["SECRET-1", setting.hidden.id, "SECRET-2"]) {
      const refused = await tool(graces, "read_ticket", { ticket });
      expect(refused.isError, ticket).toBe(true);
      expect(refused.text).toMatch(/not found|no such/i);
      expect((await tool(linuses, "read_ticket", { ticket })).isError, ticket).toBe(false);
    }
    expect((await tool(graces, "list_tickets", { project: "SECRET" })).isError).toBe(true);
    const all = await tool(graces, "list_tickets", {});
    expect(all.text).not.toMatch(/SECRET-|Hidden plans/);

    const blocked = await tool(graces, "read_ticket", { ticket: "OPEN-1" });
    expect(blocked.isError).toBe(false);
    expect(JSON.parse(blocked.text).ticket).toMatchObject({ blockedBy: [], blockedByHidden: 1 });
    expect(JSON.stringify({ ...JSON.parse(blocked.text), ticket: { description: "" } })).not.toMatch(/SECRET-|Hidden plans/);
    expect(JSON.stringify({ ...JSON.parse(blocked.text).ticket, description: "" })).not.toMatch(/SECRET-|Hidden plans/);
  });
});

const base64 = (text: string) => Buffer.from(text).toString("base64");
const page = (path: string, text: string) => ({ path, contentBase64: base64(text) });

/** Attaches a small text file to the owner at `path`, as the web client does. */
async function attach(path: string, as: As, name: string) {
  const response = await fetch(new URL(`${path}?name=${encodeURIComponent(name)}`, cronk.url), {
    method: "POST",
    headers: { ...as.headers, ...(as.cookie ? { cookie: as.cookie } : {}), "content-type": "text/plain" },
    body: "secret bytes",
  });
  const json = await response.json();
  expect(response.status, `POST ${path}: ${JSON.stringify(json)}`).toBe(201);
  return json as { id: string };
}

/**
 * The two Projects with knowledge in each place. SECRET holds a Document Plan at Version 2 with a Goals Section, a
 * Term Run, a Decision 1, an Artifact Board and a Report on SECRET-3, written by Ada's Agent during its Run there;
 * SECRET-1 links Plan and Board, and Plan, SECRET-1 and its Comment carry Attachments. The Workspace holds its own
 * Document, Term, Decision and Artifact.
 */
async function twoProjectsWithKnowledge() {
  const setting = await twoProjects();
  const { ada, secret, workspace, hidden, comment, adasAgent } = setting;
  const document = await ok("POST", `/api/projects/${secret.id}/documents`, ada, {
    title: "Plan",
    body: "# Plan\n\n## Goals\n\nSecret goals.",
  });
  await ok("PATCH", `/api/documents/${document.id}`, ada, { baseVersion: 1, body: "# Plan\n\n## Goals\n\nSecret goals, revised." });
  const term = await ok("POST", `/api/projects/${secret.id}/terms`, ada, { name: "Run", definition: "A secret run." });
  const decision = await ok("POST", `/api/projects/${secret.id}/decisions`, ada, { title: "Keep it hidden", body: "Why." });
  const artifact = await ok("POST", `/api/projects/${secret.id}/artifacts`, ada, {
    title: "Board",
    files: [page("index.html", "<!doctype html><title>Board</title>")],
  });
  await ok("POST", `/api/tickets/${hidden.id}/documents`, ada, { documentId: document.id });
  await ok("POST", `/api/tickets/${hidden.id}/artifacts`, ada, { artifactId: artifact.id });
  const attachments = {
    document: await attach(`/api/documents/${document.id}/attachments`, ada, "plan.txt"),
    ticket: await attach(`/api/tickets/${hidden.id}/attachments`, ada, "ticket.txt"),
    comment: await attach(`/api/comments/${comment.id}/attachments`, ada, "comment.txt"),
  };

  // A Report, written during a Run of Ada's Agent on SECRET-3.
  const runner = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
  await ok("PATCH", `/api/agents/${adasAgent.id}`, ada, { runnerId: runner.id });
  const reported = await ok("POST", `/api/projects/${secret.id}/tickets`, ada, { title: "Investigated" });
  const triage = secret.statuses.find((s: { name: string }) => s.name === "Triage").id;
  await ok("PATCH", `/api/tickets/${reported.id}`, ada, { delegateId: adasAgent.id, statusId: triage });
  const report = await ok("POST", `/api/tickets/${reported.id}/reports`, adasAgent.as, { title: "Findings", body: "Secret findings." });

  const own = {
    document: await ok("POST", `/api/workspaces/${workspace.id}/documents`, ada, { title: "Handbook", body: "Open." }),
    term: await ok("POST", `/api/workspaces/${workspace.id}/terms`, ada, { name: "Ticket", definition: "Work." }),
    decision: await ok("POST", `/api/workspaces/${workspace.id}/decisions`, ada, { title: "Use Postgres", body: "Why." }),
    artifact: await ok("POST", `/api/workspaces/${workspace.id}/artifacts`, ada, {
      title: "Logo",
      files: [page("index.html", "<!doctype html><title>Logo</title>")],
    }),
  };
  return { ...setting, document, term, decision, artifact, attachments, reported, report, own };
}

type Knowing = Awaited<ReturnType<typeof twoProjectsWithKnowledge>>;

/** Every read of the private Project's knowledge, Artifacts and Attachments, by id and by readable form. */
function knowledgeReads({ secret, document, term, decision, artifact, attachments, reported, report }: Knowing): string[] {
  return [
    `/api/projects/${secret.id}/documents`,
    `/api/documents/${document.id}`,
    `/api/documents/${document.slug}`,
    `/api/documents/${document.id}/versions`,
    `/api/documents/${document.id}/versions/1`,
    `/api/documents/${document.id}/versions/compare?from=1&to=2`,
    `/api/documents/${document.id}/sections?section=Goals`,
    `/api/documents/${document.id}/attachments`,
    `/api/tickets/${reported.id}/reports`,
    `/api/documents/${report.id}`,
    `/api/documents/${report.id}/versions`,
    `/api/projects/${secret.id}/terms`,
    `/api/projects/${secret.id}/glossary`,
    `/api/terms/${term.id}`,
    `/api/terms/SECRET%2FRun`,
    `/api/terms/${term.id}/versions`,
    `/api/terms/${term.id}/versions/1`,
    `/api/projects/${secret.id}/decisions`,
    `/api/decisions/${decision.id}`,
    `/api/decisions/SECRET%2F1`,
    `/api/decisions/${decision.id}/versions`,
    `/api/decisions/${decision.id}/versions/1`,
    `/api/projects/${secret.id}/artifacts`,
    `/api/artifacts/${artifact.id}`,
    `/api/artifacts/${artifact.slug}`,
    `/api/artifacts/${artifact.id}/file?path=index.html`,
    `/api/artifacts/${artifact.id}/versions`,
    `/api/tickets/SECRET-1/documents`,
    `/api/tickets/SECRET-1/artifacts`,
    `/api/tickets/SECRET-1/attachments`,
    ...Object.values(attachments).map(({ id }) => `/api/attachments/${id}/content`),
    `/api/projects/${secret.id}/export`,
    `/api/projects/${secret.id}/export.zip`,
  ];
}

async function expectKnowledge(setting: Knowing, as: As, status: 200 | 404) {
  for (const path of knowledgeReads(setting)) {
    const response = await cronk.request("GET", path, as);
    expect(response.status, path).toBe(status);
  }
}

/** Every write into the private Project's knowledge places and records. */
function knowledgeWrites({ secret, document, term, decision, artifact }: Knowing): [string, string, unknown][] {
  return [
    ["POST", `/api/projects/${secret.id}/documents`, { title: "Leak" }],
    ["PATCH", `/api/documents/${document.id}`, { baseVersion: 2, body: "Overwritten." }],
    ["POST", `/api/projects/${secret.id}/terms`, { name: "Leak", definition: "No." }],
    ["PATCH", `/api/terms/${term.id}`, { baseVersion: 1, definition: "Overwritten." }],
    ["POST", `/api/projects/${secret.id}/decisions`, { title: "Leak", body: "No." }],
    ["PATCH", `/api/decisions/${decision.id}`, { baseVersion: 1, body: "Overwritten." }],
    ["POST", `/api/projects/${secret.id}/artifacts`, { title: "Leak", files: [page("index.html", "<title>x</title>")] }],
    ["PATCH", `/api/artifacts/${artifact.id}`, { baseVersion: 1, title: "Overwritten" }],
  ];
}

describe("a private Project's knowledge and Artifacts", () => {
  test("answer as not found to a User it doesn't list, and to their Agents, over the HTTP API", async () => {
    const setting = await twoProjectsWithKnowledge();
    await expectKnowledge(setting, setting.grace.as, 200);
    await setting.makePrivate();

    for (const as of [setting.grace.as, setting.gracesAgent.as]) {
      await expectKnowledge(setting, as, 404);
      for (const [method, path, body] of knowledgeWrites(setting)) {
        expect((await call(method, path, as, body)).status, `${method} ${path}`).toBe(404);
      }
      expect((await call("DELETE", `/api/attachments/${setting.attachments.document.id}`, as)).status).toBe(404);
    }
    expect((await ok("GET", `/api/documents/${setting.document.id}`, setting.ada)).version.number).toBe(2);
    expect((await ok("GET", `/api/terms/${setting.term.id}`, setting.ada)).definition).toBe("A secret run.");
  });

  test("stay readable and writable for Admins, the Users it lists and their Agents", async () => {
    const setting = await twoProjectsWithKnowledge();
    await setting.makePrivate();

    for (const as of [setting.ada, setting.adasAgent.as, setting.linus.as, setting.linusesAgent.as]) {
      await expectKnowledge(setting, as, 200);
    }
    const saved = await ok("PATCH", `/api/terms/${setting.term.id}`, setting.linusesAgent.as, {
      baseVersion: 1,
      definition: "A listed run.",
    });
    expect(saved.version.number).toBe(2);
    await ok("POST", `/api/projects/${setting.secret.id}/documents`, setting.linus.as, { title: "Notes" });
  });

  test("leave the Workspace's own knowledge readable and writable to every User and their Agents", async () => {
    const setting = await twoProjectsWithKnowledge();
    const { workspace, own, grace, gracesAgent } = setting;
    await setting.makePrivate();

    for (const as of [grace.as, gracesAgent.as]) {
      for (const path of [
        `/api/workspaces/${workspace.id}/documents`,
        `/api/documents/${own.document.id}`,
        `/api/workspaces/${workspace.id}/terms`,
        `/api/terms/Ticket`,
        `/api/workspaces/${workspace.id}/decisions`,
        `/api/decisions/1`,
        `/api/workspaces/${workspace.id}/artifacts`,
        `/api/artifacts/${own.artifact.id}`,
        `/api/workspaces/${workspace.id}/export`,
      ]) {
        expect((await call("GET", path, as)).status, path).toBe(200);
      }
      await ok("POST", `/api/workspaces/${workspace.id}/documents`, as, { title: "Mine" });
      await attach(`/api/documents/${own.document.id}/attachments`, as, "mine.txt");
    }
    const documents = await ok("GET", `/api/workspaces/${workspace.id}/documents`, grace.as);
    expect(JSON.stringify(documents)).not.toMatch(/Plan|Secret/);
    const artifacts = await ok("GET", `/api/workspaces/${workspace.id}/artifacts`, grace.as);
    expect(artifacts.map((a: { title: string }) => a.title)).toEqual(["Logo"]);
    const saved = await ok("PATCH", `/api/terms/${own.term.id}`, gracesAgent.as, { baseVersion: 1, definition: "Work to do." });
    expect(saved.version.number).toBe(2);
  });

  test("leave a Ticket's Linked Documents and Artifacts the viewer can't read off it", async () => {
    const setting = await twoProjectsWithKnowledge();
    const { related, document, artifact, workspace, own, ada, grace } = setting;
    await ok("POST", `/api/tickets/${related.id}/documents`, ada, { documentId: own.document.id });
    await ok("POST", `/api/tickets/${related.id}/artifacts`, ada, { artifactId: own.artifact.id });
    // Links to the private Project's knowledge from another Project's Ticket, which linking itself refuses, so a
    // Ticket a viewer reads can link what they can't.
    for (const [table, column, id] of [
      ["linked_documents", "document_id", document.id],
      ["linked_artifacts", "artifact_id", artifact.id],
    ]) {
      await cronk.stage(`insert into ${table} (ticket_id, ${column}, workspace_id, created_at) values ($1, $2, $3, now())`, [
        related.id,
        id,
        workspace.id,
      ]);
    }
    const titles = async (as: As, kind: string) =>
      (await ok("GET", `/api/tickets/${related.id}/${kind}`, as)).map((linked: { title: string }) => linked.title);
    await setting.makePrivate();

    expect(await titles(ada, "documents")).toEqual(["Handbook", "Plan"]);
    expect(await titles(ada, "artifacts")).toEqual(["Logo", "Board"]);
    for (const as of [grace.as, setting.gracesAgent.as]) {
      expect(await titles(as, "documents")).toEqual(["Handbook"]);
      expect(await titles(as, "artifacts")).toEqual(["Logo"]);
    }
    const graces = await connect(setting.gracesAgent.secret);
    const read = JSON.parse((await tool(graces, "read_ticket", { ticket: "OPEN-2" })).text);
    expect(read.linkedDocuments.map((d: { title: string }) => d.title)).toEqual(["Handbook"]);
    expect(read.linkedArtifacts.map((a: { title: string }) => a.title)).toEqual(["Logo"]);
  });

  test("answer as not found to the Agents of a User it doesn't list over MCP", async () => {
    const setting = await twoProjectsWithKnowledge();
    await setting.makePrivate();
    const graces = await connect(setting.gracesAgent.secret);
    const linuses = await connect(setting.linusesAgent.secret);

    const calls: [string, Record<string, unknown>][] = [
      ["list_documents", { project: "SECRET" }],
      ["read_document", { document: setting.document.slug }],
      ["read_document", { document: setting.report.id }],
      ["list_document_versions", { document: setting.document.id }],
      ["read_glossary", { project: "SECRET" }],
      ["read_term", { term: "SECRET/Run" }],
      ["list_term_versions", { term: setting.term.id }],
      ["list_decisions", { project: "SECRET" }],
      ["read_decision", { decision: "SECRET/1" }],
      ["list_artifacts", { project: "SECRET" }],
      ["read_artifact", { artifact: setting.artifact.slug }],
      ["export_knowledge", { project: "SECRET" }],
    ];
    for (const [name, args] of calls) {
      const refused = await tool(graces, name, args);
      expect(refused.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(refused.text).not.toMatch(/Secret goals|A secret run|Keep it hidden|Secret findings/);
      expect((await tool(linuses, name, args)).isError, `${name} ${JSON.stringify(args)}`).toBe(false);
    }
    const glossary = await tool(graces, "read_glossary", {});
    expect(glossary.isError).toBe(false);
    expect(glossary.text).not.toContain("A secret run");
  });
});
