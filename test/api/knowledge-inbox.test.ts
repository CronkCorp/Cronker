import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";
import { openStream, type OpenStream } from "../harness/stream.js";

/*
 * New knowledge in the Inbox (CRONK-110): each Decision, Term, Document or Artifact an Agent creates waits as one
 * item for the Assignee of its Run's Ticket, or else the Agent's Owner, until they dismiss it; a Decision also until
 * its status leaves proposed.
 */

let cronk: StartedCronk;
beforeEach(async () => {
  cronk = await startCronk();
});
const streams: OpenStream[] = [];
afterEach(async () => {
  for (const stream of streams.splice(0)) stream.close();
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

/** Ada's Workspace with a Project, Bea as a member, and Ada's Agent `claude-max` on the fake Runner. */
async function withAgent() {
  const { workspace, user } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk), id: user.id };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const runner = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, ada, { runnerId: runner.id });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "cloud", access: "write" });
  const asAgent = { headers: { authorization: `Bearer ${secret}` } };
  const bea = await addMember(cronk, ada.cookie, workspace.id, "bea@example.com");
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id as string;
  const inbox = async (as: As) => (await ok("GET", `/api/workspaces/${workspace.id}/inbox`, as)).items as Record<string, any>[];
  const knowledge = async (as: As) => (await inbox(as)).filter((item) => item.kind === "knowledge");
  /** Bea's own Agent, on her own fake Runner. */
  const beasAgent = async () => {
    const as = { cookie: bea.cookie };
    const runner = await ok("POST", "/api/runners", as, { name: "Bea's", kind: "fake" });
    const made = await ok("POST", `/api/workspaces/${workspace.id}/agents`, as, { name: "bea-bot" });
    const own = await ok("PATCH", `/api/agents/${made.id}`, as, { runnerId: runner.id });
    const token = await ok("POST", `/api/agents/${own.id}/tokens`, as, { name: "cloud", access: "write" });
    return { agent: own, asAgent: { headers: { authorization: `Bearer ${token.secret}` } } };
  };
  return { workspace, ada, bea: { cookie: bea.cookie, id: bea.user.id as string }, project, agent, asAgent, status, knowledge, beasAgent };
}

const page = Buffer.from("<!doctype html><title>Board</title><p>Hello</p>").toString("base64");

describe("knowledge an Agent creates", () => {
  test("each Decision, Term, Document and Artifact waits as one New knowledge item for the Agent's Owner", async () => {
    const { ada, bea, project, agent, asAgent, knowledge } = await withAgent();
    const decision = await ok("POST", `/api/projects/${project.id}/decisions`, asAgent, { title: "Use Postgres", body: "Because." });
    cronk.clock.advance(1000);
    const term = await ok("POST", `/api/projects/${project.id}/terms`, asAgent, { name: "Run", definition: "One go." });
    cronk.clock.advance(1000);
    const document = await ok("POST", `/api/projects/${project.id}/documents`, asAgent, { title: "Plan", body: "Steps." });
    cronk.clock.advance(1000);
    const artifact = await ok("POST", `/api/projects/${project.id}/artifacts`, asAgent, {
      title: "Board",
      files: [{ path: "index.html", contentBase64: page }],
    });

    const items = await knowledge(ada);
    expect(items).toEqual([
      {
        kind: "knowledge",
        id: expect.any(String),
        subject: {
          kind: "decision",
          id: decision.id,
          title: "Use Postgres",
          projectId: project.id,
          projectKey: "CRONK",
          slug: null,
          number: 1,
          status: "proposed",
        },
        agent: { id: agent.id, name: "claude-max" },
        run: null,
        since: "2026-01-01T09:00:00.000Z",
      },
      expect.objectContaining({ subject: expect.objectContaining({ kind: "term", id: term.id, title: "Run", slug: null }) }),
      expect.objectContaining({ subject: expect.objectContaining({ kind: "document", id: document.id, title: "Plan", slug: document.slug }) }),
      expect.objectContaining({ subject: expect.objectContaining({ kind: "artifact", id: artifact.id, title: "Board", slug: artifact.slug }) }),
    ]);
    expect(new Set(items.map((i) => i.id)).size).toBe(4);
    expect(await knowledge(bea)).toEqual([]);
  });

  test("knowledge a User creates, or a new Version an Agent saves, makes no item", async () => {
    const { ada, project, asAgent, knowledge } = await withAgent();
    await ok("POST", `/api/projects/${project.id}/terms`, ada, { name: "Ticket" });
    await ok("POST", `/api/projects/${project.id}/documents`, ada, { title: "Notes" });
    const term = await ok("POST", `/api/projects/${project.id}/terms`, asAgent, { name: "Run" });
    await ok("POST", `/api/knowledge-notices/${(await knowledge(ada))[0]!.id}/dismiss`, ada);
    await ok("PATCH", `/api/terms/${term.id}`, asAgent, { baseVersion: 1, definition: "One go." });
    expect(await knowledge(ada)).toEqual([]);
  });

  test("created in a Run, it waits for the Assignee of the Run's Ticket and names the Run", async () => {
    const { ada, bea, project, status, knowledge, beasAgent } = await withAgent();
    const { agent, asAgent } = await beasAgent();
    const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, bea, { title: "Make it so" });
    await ok("PATCH", `/api/tickets/${ticket.id}`, bea, { assigneeId: bea.id, delegateId: agent.id, statusId: status("Triage") });
    const [run] = await ok("GET", `/api/tickets/${ticket.id}/runs`, ada);
    expect(run.state).toBe("running");

    await ok("POST", `/api/projects/${project.id}/terms`, asAgent, { name: "Run", runId: run.id });
    await ok("POST", `/api/projects/${project.id}/decisions`, asAgent, { title: "Use Postgres", runId: run.id });
    await ok("POST", `/api/projects/${project.id}/documents`, asAgent, { title: "Plan", runId: run.id });

    const items = await knowledge(bea);
    expect(items.map((i) => [i.subject.kind, i.run]).sort()).toEqual([
      ["decision", run.id],
      ["document", run.id],
      ["term", run.id],
    ]);
    expect(await knowledge(ada)).toEqual([]);
  });

  test("a Run is named only by an Agent, and only its own running one", async () => {
    const { ada, project, asAgent } = await withAgent();
    const byUser = await call("POST", `/api/projects/${project.id}/terms`, ada, { name: "Run", runId: crypto.randomUUID() });
    expect(byUser.status).toBe(400);
    expect(byUser.json.error.code).toBe("run_for_agents");
    const noRun = await call("POST", `/api/projects/${project.id}/decisions`, asAgent, { title: "Use Postgres", runId: crypto.randomUUID() });
    expect(noRun.status).toBe(403);
    expect(noRun.json.error.code).toBe("no_running_run");
  });
});

describe("a New knowledge item", () => {
  test("Dismiss clears it from its User's Inbox, leaving the knowledge; nobody else can dismiss it", async () => {
    const { ada, bea, project, asAgent, knowledge } = await withAgent();
    const term = await ok("POST", `/api/projects/${project.id}/terms`, asAgent, { name: "Run" });
    const [item] = await knowledge(ada);

    expect((await call("POST", `/api/knowledge-notices/${item!.id}/dismiss`, bea)).status).toBe(404);
    expect((await call("POST", `/api/knowledge-notices/not-an-id/dismiss`, ada)).status).toBe(404);
    expect(await knowledge(ada)).toHaveLength(1);

    expect((await call("POST", `/api/knowledge-notices/${item!.id}/dismiss`, ada)).status).toBe(204);
    expect(await knowledge(ada)).toEqual([]);
    expect((await ok("GET", `/api/terms/${term.id}`, ada)).name).toBe("Run");
  });

  test("a proposed Decision's item clears once a User accepts or rejects it", async () => {
    const { ada, project, asAgent, knowledge } = await withAgent();
    const accepted = await ok("POST", `/api/projects/${project.id}/decisions`, asAgent, { title: "Use Postgres" });
    const rejected = await ok("POST", `/api/projects/${project.id}/decisions`, asAgent, { title: "Use Mongo" });
    const edited = await ok("POST", `/api/projects/${project.id}/decisions`, asAgent, { title: "Use Redis" });
    await ok("PATCH", `/api/decisions/${accepted.id}`, ada, { baseVersion: 1, status: "accepted" });
    await ok("PATCH", `/api/decisions/${rejected.id}`, ada, { baseVersion: 1, status: "rejected" });
    await ok("PATCH", `/api/decisions/${edited.id}`, ada, { baseVersion: 1, body: "For caching." });

    expect((await knowledge(ada)).map((i) => i.subject.id)).toEqual([edited.id]);
    // Set back to proposed, a decided Decision stays out of the Inbox.
    await ok("PATCH", `/api/decisions/${accepted.id}`, ada, { baseVersion: 2, status: "proposed" });
    expect((await knowledge(ada)).map((i) => i.subject.id)).toEqual([edited.id]);
  });

  test("goes with its knowledge when that is deleted", async () => {
    const { ada, project, asAgent, knowledge } = await withAgent();
    const document = await ok("POST", `/api/projects/${project.id}/documents`, asAgent, { title: "Plan" });
    expect(await knowledge(ada)).toHaveLength(1);
    await ok("DELETE", `/api/documents/${document.id}`, ada);
    expect(await knowledge(ada)).toEqual([]);
  });

  test("of the Workspace's own knowledge shows; of an archived Project, not until it is unarchived", async () => {
    const { workspace, ada, project, asAgent, knowledge } = await withAgent();
    await ok("POST", `/api/workspaces/${workspace.id}/terms`, asAgent, { name: "Workspace" });
    cronk.clock.advance(1000);
    await ok("POST", `/api/projects/${project.id}/terms`, asAgent, { name: "Run" });
    await ok("POST", `/api/projects/${project.id}/archive`, ada);
    expect((await knowledge(ada)).map((i) => [i.subject.title, i.subject.projectId])).toEqual([["Workspace", null]]);
    await ok("POST", `/api/projects/${project.id}/unarchive`, ada);
    expect((await knowledge(ada)).map((i) => i.subject.title)).toEqual(["Workspace", "Run"]);
  });

  test("of a Project its User can't read doesn't show", async () => {
    const { ada, bea, project, knowledge, beasAgent } = await withAgent();
    const { asAgent } = await beasAgent();
    await ok("POST", `/api/projects/${project.id}/terms`, asAgent, { name: "Run" });
    expect(await knowledge(bea)).toHaveLength(1);
    // Made private without Bea, the Project's item for her waits on, out of sight, and shows again with her Access.
    await ok("PUT", `/api/projects/${project.id}/access`, ada, { visibility: "private", users: [], agentAccess: "write" });
    expect(await knowledge(bea)).toEqual([]);
    await ok("PUT", `/api/projects/${project.id}/access`, ada, { visibility: "open", users: [], agentAccess: "write" });
    expect(await knowledge(bea)).toHaveLength(1);
  });

  test("arrives live in its User's Inbox, and leaves live when dismissed", async () => {
    const { workspace, ada, bea, project, asAgent, knowledge } = await withAgent();
    const adaStream = await openStream(cronk, ada.cookie, workspace.id);
    const beaStream = await openStream(cronk, bea.cookie, workspace.id);
    streams.push(adaStream, beaStream);

    await ok("POST", `/api/projects/${project.id}/terms`, asAgent, { name: "Run" });
    const told = [await adaStream.next(), await adaStream.next()].map((e) => e.type).sort();
    expect(told).toEqual(["inbox.changed", "term.changed"]);
    expect((await beaStream.next()).type).toBe("term.changed");

    const [item] = await knowledge(ada);
    await ok("POST", `/api/knowledge-notices/${item!.id}/dismiss`, ada);
    expect((await adaStream.next()).type).toBe("inbox.changed");
    await beaStream.expectQuiet(200);
  });
});
