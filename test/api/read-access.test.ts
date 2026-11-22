import { afterEach, describe, expect, test } from "vitest";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

/**
 * Read (ADR 0010): an Admin lists a User on a Project, open or private, with Read, so they follow its work without
 * changing it. Every read answers as it does for Write; every write is refused with `read_access`, naming the rule
 * and advice, and changes nothing. Assigning a Ticket to a User without Write in its Project is refused.
 */

let cronk: StartedCronk;
afterEach(async () => {
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

async function attach(path: string, as: As, name: string) {
  const response = await fetch(new URL(`${path}?name=${encodeURIComponent(name)}`, cronk.url), {
    method: "POST",
    headers: { ...as.headers, ...(as.cookie ? { cookie: as.cookie } : {}), "content-type": "text/plain" },
    body: "notes",
  });
  return { status: response.status, json: await response.json() };
}

const base64 = (text: string) => Buffer.from(text).toString("base64");

/**
 * Ada, the Admin, with a Project CRONK, open or private, listing Grace with Read; Linus, a member it doesn't list.
 * CRONK-1 has a Comment, an Attachment, a Relation to CRONK-2 and links a Document; CRONK holds a Document, Term,
 * Decision and Artifact. Grace has an Agent with a full token.
 */
async function projectWithReader(visibility: "open" | "private") {
  cronk = await startCronk();
  const { workspace } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const grace = await addMember(cronk, ada.cookie, workspace.id, "grace@example.com");
  const linus = await addMember(cronk, ada.cookie, workspace.id, "linus@example.com");
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Read access" });
  const other = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Losing Write" });
  const comment = await ok("POST", `/api/tickets/${ticket.id}/comments`, ada, { body: "Mind the Admins." });
  const relation = await ok("POST", `/api/tickets/${ticket.id}/relations`, ada, { kind: "blocks", ticketId: other.id });
  const attached = await attach(`/api/tickets/${ticket.id}/attachments`, ada, "notes.txt");
  expect(attached.status).toBe(201);
  const document = await ok("POST", `/api/projects/${project.id}/documents`, ada, { title: "Plan", body: "# One\n\nFirst." });
  await ok("POST", `/api/tickets/${ticket.id}/documents`, ada, { documentId: document.id });
  const term = await ok("POST", `/api/projects/${project.id}/terms`, ada, { name: "Access", definition: "Read or Write." });
  const decision = await ok("POST", `/api/projects/${project.id}/decisions`, ada, { title: "Seam first", body: "Why." });
  const artifact = await ok("POST", `/api/projects/${project.id}/artifacts`, ada, {
    title: "Board",
    files: [{ path: "index.html", contentBase64: base64("<p>Board</p>") }],
  });
  await ok("PUT", `/api/projects/${project.id}/access`, ada, {
    visibility,
    users: [{ userId: grace.user.id, level: "read" }],
  });
  const agent = await ok("POST", `/api/workspaces/${workspace.id}/agents`, { cookie: grace.cookie }, { name: "grace-claude" });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, { cookie: grace.cookie }, { name: "laptop", access: "full" });
  return {
    workspace,
    ada,
    grace: { ...grace, as: { cookie: grace.cookie } },
    linus: { ...linus, as: { cookie: linus.cookie } },
    gracesAgent: { headers: { authorization: `Bearer ${secret}` } },
    project,
    ticket,
    other,
    comment,
    relation,
    attachment: attached.json,
    document,
    term,
    decision,
    artifact,
  };
}

type Setting = Awaited<ReturnType<typeof projectWithReader>>;

/** Every read of the Project and what is in it. */
function reads({ project, ticket, document, term, decision, artifact }: Setting): string[] {
  return [
    `/api/projects/${project.id}`,
    `/api/projects/${project.id}/tickets`,
    `/api/tickets/${ticket.id}`,
    `/api/tickets/${ticket.id}/comments`,
    `/api/tickets/${ticket.id}/relations`,
    `/api/tickets/${ticket.id}/attachments`,
    `/api/tickets/${ticket.id}/documents`,
    `/api/tickets/${ticket.id}/artifacts`,
    `/api/tickets/${ticket.id}/timeline`,
    `/api/tickets/${ticket.id}/runs`,
    `/api/projects/${project.id}/documents`,
    `/api/documents/${document.id}`,
    `/api/documents/${document.id}/versions`,
    `/api/projects/${project.id}/terms`,
    `/api/terms/${term.id}`,
    `/api/projects/${project.id}/decisions`,
    `/api/decisions/${decision.id}`,
    `/api/projects/${project.id}/artifacts`,
    `/api/artifacts/${artifact.id}`,
    `/api/artifacts/${artifact.id}/comments`,
    `/api/documents/${document.id}/comments`,
    `/api/projects/${project.id}/repositories`,
  ];
}

/** Every write the Project takes, each of which Read refuses. */
function writes(setting: Setting): [string, string, unknown?][] {
  const { project, ticket, other, comment, relation, attachment, document, term, decision, artifact } = setting;
  const backlog = project.statuses.find((s: { kind: string }) => s.kind === "backlog").id;
  const active = project.statuses.find((s: { kind: string }) => s.kind === "active").id;
  return [
    // Creating and editing Tickets, and moving them
    ["POST", `/api/projects/${project.id}/tickets`, { title: "Mine" }],
    ["POST", `/api/projects/${project.id}/tickets`, { title: "Part", parentId: ticket.id }],
    ["PATCH", `/api/tickets/${ticket.id}`, { title: "Renamed" }],
    ["PATCH", `/api/tickets/${ticket.id}`, { statusId: active }],
    ["PATCH", `/api/tickets/${ticket.id}`, { priority: "high" }],
    ["POST", `/api/tickets/${ticket.id}/dismiss`],
    ["POST", `/api/tickets/${ticket.id}/accept`],
    ["POST", `/api/tickets/${ticket.id}/reopen`, { comment: "Not done." }],
    ["POST", `/api/tickets/${ticket.id}/retry`],
    // Comments
    ["POST", `/api/tickets/${ticket.id}/comments`, { body: "Mine." }],
    ["POST", `/api/tickets/${ticket.id}/comments`, { body: "A reply.", replyToId: comment.id }],
    // Relations
    ["POST", `/api/tickets/${ticket.id}/relations`, { kind: "relatesTo", ticketId: other.id }],
    ["DELETE", `/api/tickets/${ticket.id}/relations/${relation.id}`],
    // Labels
    ["PATCH", `/api/tickets/${ticket.id}`, { labels: ["access"] }],
    // Knowledge and Artifacts, and linking them
    ["POST", `/api/projects/${project.id}/documents`, { title: "Mine" }],
    ["PATCH", `/api/documents/${document.id}`, { baseVersion: 1, body: "Two." }],
    ["PATCH", `/api/documents/${document.id}`, { position: 0 }],
    ["PUT", `/api/documents/${document.id}/sections`, { section: "One", baseVersion: 1, body: "# One\n\nSecond." }],
    ["DELETE", `/api/documents/${document.id}`],
    ["DELETE", `/api/tickets/${ticket.id}/documents/${document.id}`],
    ["POST", `/api/projects/${project.id}/terms`, { name: "Read", definition: "Only reading." }],
    ["PATCH", `/api/terms/${term.id}`, { baseVersion: 1, definition: "Changed." }],
    ["DELETE", `/api/terms/${term.id}`],
    ["POST", `/api/projects/${project.id}/decisions`, { title: "Mine", body: "Why." }],
    ["PATCH", `/api/decisions/${decision.id}`, { baseVersion: 1, body: "Changed." }],
    ["PATCH", `/api/decisions/${decision.id}`, { baseVersion: 1, status: "accepted" }],
    ["POST", `/api/projects/${project.id}/artifacts`, { title: "Mine", files: [{ path: "index.html", contentBase64: base64("x") }] }],
    ["PATCH", `/api/artifacts/${artifact.id}`, { baseVersion: 1, title: "Changed" }],
    ["DELETE", `/api/artifacts/${artifact.id}`],
    ["POST", `/api/artifacts/${artifact.id}/comments`, { body: "Mine." }],
    ["POST", `/api/documents/${document.id}/comments`, { body: "Mine." }],
    ["POST", `/api/tickets/${ticket.id}/artifacts`, { artifactId: artifact.id }],
    ["DELETE", `/api/tickets/${ticket.id}/artifacts/${artifact.id}`],
    // Attachments
    ["DELETE", `/api/attachments/${attachment.id}`],
    // Pull Requests linked by hand
    ["POST", `/api/tickets/${ticket.id}/pull-requests`, { pullRequest: "cronkcorp/cronker#1" }],
    ["DELETE", `/api/tickets/${ticket.id}/pull-requests/1`],
    // Repositories
    ["POST", `/api/projects/${project.id}/repositories`, { id: 1 }],
    ["DELETE", `/api/projects/${project.id}/repositories/1`],
    // The Project's settings
    ["PATCH", `/api/projects/${project.id}`, { newTicketsDelegated: true }],
    ["POST", `/api/projects/${project.id}/statuses`, { name: "Waiting", kind: "backlog" }],
    ["PATCH", `/api/projects/${project.id}/statuses/${backlog}`, { name: "Later" }],
    ["DELETE", `/api/projects/${project.id}/statuses/${backlog}`],
    ["DELETE", `/api/projects/${project.id}/statuses/${active}/step`],
  ];
}

/** What the Project and everything in it read as, to Ada, the Admin. */
async function snapshot(setting: Setting) {
  const all: Record<string, unknown> = {};
  for (const path of reads(setting)) all[path] = await ok("GET", path, setting.ada);
  return all;
}

describe.each(["open", "private"] as const)("a User with Read in a%s Project", (visibility) => {
  test("reads everything in it as an Admin does", async () => {
    const setting = await projectWithReader(visibility);
    const { ada, grace, gracesAgent, project, workspace } = setting;

    const sameAs = (json: Record<string, unknown>) => ({ ...json, access: undefined });
    for (const path of reads(setting)) {
      const asAdmin = await ok("GET", path, ada);
      expect(sameAs(await ok("GET", path, grace.as)), path).toEqual(sameAs(asAdmin));
      expect(sameAs(await ok("GET", path, gracesAgent)), path).toEqual(sameAs(asAdmin));
    }
    expect((await ok("GET", `/api/projects/${project.id}`, grace.as)).access).toBe("read");
    expect((await ok("GET", `/api/projects/${project.id}`, gracesAgent)).access).toBe("read");
    const listed = await ok("GET", `/api/workspaces/${workspace.id}/projects`, grace.as);
    expect(listed.map((p: { key: string; access: string }) => [p.key, p.access])).toEqual([["CRONK", "read"]]);
  });

  test("has every write refused with the rule, changing nothing, as have their Agents", async () => {
    const setting = await projectWithReader(visibility);
    const before = await snapshot(setting);

    for (const as of [setting.grace.as, setting.gracesAgent]) {
      for (const [method, path, body] of writes(setting)) {
        const response = await call(method, path, as, body);
        // An Agent meets the rules for Agents first wherever only a User may act; neither changes anything.
        if (as === setting.gracesAgent && /^agent_/.test(response.json?.error?.code ?? "")) continue;
        expect(response, `${method} ${path}`).toEqual({
          status: 403,
          json: {
            error: {
              code: "read_access",
              message: expect.any(String),
              rule: expect.stringContaining("Read"),
              advice: expect.stringContaining("Write"),
            },
          },
        });
      }
      const attached = await attach(`/api/tickets/${setting.ticket.id}/attachments`, as, "mine.txt");
      expect(attached.status).toBe(403);
      expect(attached.json.error.code).toBe("read_access");
    }
    expect(await snapshot(setting)).toEqual(before);
  });

  test("leaves the Workspace's own knowledge in their hands", async () => {
    const { grace, workspace } = await projectWithReader(visibility);

    await ok("POST", `/api/workspaces/${workspace.id}/documents`, grace.as, { title: "Handbook" });
    await ok("POST", `/api/workspaces/${workspace.id}/terms`, grace.as, { name: "Workspace", definition: "Ours." });
  });

  test("can't be made a Ticket's Assignee, nor can anyone else without Write", async () => {
    const { ada, grace, linus, ticket } = await projectWithReader(visibility);

    const assigned = await call("PATCH", `/api/tickets/${ticket.id}`, ada, { assigneeId: grace.user.id });
    expect(assigned).toEqual({
      status: 400,
      json: {
        error: {
          code: "assignee_cannot_write",
          message: expect.stringContaining("grace@example.com"),
          rule: expect.any(String),
          advice: expect.any(String),
        },
      },
    });
    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).assigneeId).toBeNull();
    // Linus, unlisted, has Write in an open Project and nothing in a private one.
    const linusAssigned = await call("PATCH", `/api/tickets/${ticket.id}`, ada, { assigneeId: linus.user.id });
    expect(linusAssigned.status).toBe(visibility === "open" ? 200 : 400);
  });
});

describe("Write in the same Project", () => {
  test("an Admin, a User listed with Write and, in an open Project, an unlisted User still write", async () => {
    const setting = await projectWithReader("open");
    const { ada, grace, linus, project, ticket, workspace } = setting;
    const hopper = await addMember(cronk, ada.cookie, workspace.id, "hopper@example.com");
    await ok("PUT", `/api/projects/${project.id}/access`, ada, {
      visibility: "open",
      users: [
        { userId: grace.user.id, level: "read" },
        { userId: hopper.user.id, level: "write" },
      ],
    });

    for (const as of [ada, { cookie: hopper.cookie }, linus.as]) {
      expect((await ok("GET", `/api/projects/${project.id}`, as)).access).toBe("write");
      await ok("POST", `/api/tickets/${ticket.id}/comments`, as, { body: "Writing." });
      await ok("POST", `/api/projects/${project.id}/tickets`, as, { title: "New" });
    }
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { assigneeId: hopper.user.id });
  });

  test("lists Users with Read or Write, and Write again lets them write", async () => {
    const { ada, grace, project, ticket } = await projectWithReader("private");

    expect(await ok("GET", `/api/projects/${project.id}/access`, ada)).toEqual({
      visibility: "private",
      users: [{ userId: grace.user.id, level: "read" }],
      agentAccess: "write",
    });
    expect((await call("POST", `/api/tickets/${ticket.id}/comments`, grace.as, { body: "Mine." })).status).toBe(403);
    await ok("PUT", `/api/projects/${project.id}/access`, ada, {
      visibility: "private",
      users: [{ userId: grace.user.id, level: "write" }],
    });
    await ok("POST", `/api/tickets/${ticket.id}/comments`, grace.as, { body: "Mine." });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { assigneeId: grace.user.id });
  });
});
