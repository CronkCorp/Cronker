import { afterEach, describe, expect, test } from "vitest";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

/**
 * Term Mentions (CRONK-13): a Term's name, written with its capitalisation as a whole word outside code and links,
 * mentions the Term in every text, by the glossary of the text's place, the longest name first; a Term lists the
 * texts mentioning it under Mentioned in, as far as the reader may read; creating, renaming or removing a Term indexes
 * the texts again after its save.
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

/** Ada with a Project CRONK. */
async function workspaceWithProject() {
  cronk = await startCronk();
  const { workspace, user } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  return { workspace, user, ada, project };
}

type Setting = Awaited<ReturnType<typeof workspaceWithProject>>;
type Term = { id: string; name: string; projectId: string | null };

const workspaceTerm = (s: Setting, name: string, definition = "") =>
  ok("POST", `/api/workspaces/${s.workspace.id}/terms`, s.ada, { name, definition }) as Promise<Term>;
const projectTerm = (s: Setting, name: string, definition = "") =>
  ok("POST", `/api/projects/${s.project.id}/terms`, s.ada, { name, definition }) as Promise<Term>;

/** A Project Document with the Markdown given, and how to read its Mentions again. */
async function document(s: Setting, body: string, projectId: string | null = s.project.id) {
  const path = projectId ? `/api/projects/${projectId}/documents` : `/api/workspaces/${s.workspace.id}/documents`;
  const written = await ok("POST", path, s.ada, { title: "Plan", body });
  return { ...written, read: async (as: As = s.ada) => (await ok("GET", `/api/documents/${written.id}`, as)).mentions };
}

const mentionOf = (term: Term, text = term.name) => ({
  kind: "term",
  text,
  termId: term.id,
  name: term.name,
  projectId: term.projectId,
});

const mentionedIn = async (as: As, termId: string) =>
  (await ok("GET", `/api/terms/${termId}`, as)).mentionedIn.map((t: { kind: string; id: string }) => [t.kind, t.id]);

describe("which names are Mentions", () => {
  test("a name mentions its Term only with its capitalisation and as a whole word", async () => {
    const s = await workspaceWithProject();
    const run = await workspaceTerm(s, "Run");
    const node = await workspaceTerm(s, "Node.js");

    const none = await document(s, "A run, a RUN, a Runner, a Rerun, a Run_1, Run2 and Node.jsx.");
    expect(none.mentions).toEqual([]);

    const some = await document(s, "Each Run (one Run, “Run”) uses Node.js.");
    expect(some.mentions).toEqual([mentionOf(run), mentionOf(node)]);
  });

  test("where names overlap, the longest wins", async () => {
    const s = await workspaceWithProject();
    const agent = await workspaceTerm(s, "Agent");
    const record = await workspaceTerm(s, "Agent Record");

    expect((await document(s, "Keep the Agent Record.")).mentions).toEqual([mentionOf(record)]);
    expect((await document(s, "The Agent Record of an Agent.")).mentions).toEqual([mentionOf(record), mentionOf(agent)]);
  });

  test("names in code spans, code blocks and links stay plain text", async () => {
    const s = await workspaceWithProject();
    const run = await workspaceTerm(s, "Run");

    const markdown = ["`Run` and [Run](https://example.com), <https://example.com/Run>", "", "```", "Run", "```"].join("\n");
    expect((await document(s, markdown)).mentions).toEqual([]);
    expect((await document(s, "But *Run* in emphasis and **Run** are.")).mentions).toEqual([mentionOf(run)]);
  });

  test("a Project's text mentions its Project's Term over the Workspace's of the same name, other texts the Workspace's", async () => {
    const s = await workspaceWithProject();
    const ops = await ok("POST", `/api/workspaces/${s.workspace.id}/projects`, s.ada, { name: "Operations", key: "OPS" });
    const workspaceLane = await workspaceTerm(s, "Lane");
    const projectLane = await projectTerm(s, "lane");

    expect((await document(s, "One Lane, one lane.")).mentions).toEqual([mentionOf(projectLane)]);
    expect((await document(s, "One Lane, one lane.", ops.id)).mentions).toEqual([mentionOf(workspaceLane)]);
    expect((await document(s, "One Lane, one lane.", null)).mentions).toEqual([mentionOf(workspaceLane)]);
  });

  test("every kind of text mentions Terms, beside its Ticket keys, and a Term's definition doesn't mention itself", async () => {
    const s = await workspaceWithProject();
    const run = await projectTerm(s, "Run", "A Run of an Agent.");
    const agent = await projectTerm(s, "Agent", "Does a Run.");
    const ticket = await ok("POST", `/api/projects/${s.project.id}/tickets`, s.ada, { title: "Do", description: "CRONK-1 starts a Run." });
    const comment = await ok("POST", `/api/tickets/${ticket.id}/comments`, s.ada, { body: "The Agent and CRONK-1." });
    const decision = await ok("POST", `/api/projects/${s.project.id}/decisions`, s.ada, { title: "Runs", body: "One Run." });

    const key = { kind: "ticket", text: "CRONK-1", key: "CRONK-1", ticketId: ticket.id };
    expect((await ok("GET", `/api/terms/${run.id}`, s.ada)).mentions).toEqual([mentionOf(agent)]);
    expect((await ok("GET", `/api/terms/${agent.id}`, s.ada)).mentions).toEqual([mentionOf(run)]);
    expect(ticket.mentions).toEqual([key, mentionOf(run)]);
    expect(comment.mentions).toEqual([key, mentionOf(agent)]);
    expect(decision.mentions).toEqual([mentionOf(run)]);
    // Created before the Agent Term, the Run Term's definition was indexed again once it was.
    await cronk.jobsSettled();
    expect(await mentionedIn(s.ada, run.id)).toEqual([
      ["decision", decision.id],
      ["ticket", ticket.id],
      ["term", agent.id],
    ]);
    expect(await mentionedIn(s.ada, agent.id)).toEqual([
      ["comment", comment.id],
      ["term", run.id],
    ]);
  });

  test("a text mentions Terms beside Decision keys, and a Comment on a Project's Artifact or Document by its Project's glossary", async () => {
    const s = await workspaceWithProject();
    const workspaceLane = await workspaceTerm(s, "Lane");
    const projectLane = await projectTerm(s, "Lane");
    const decision = await ok("POST", `/api/projects/${s.project.id}/decisions`, s.ada, { title: "Lanes", body: "" });
    const files = [{ path: "index.html", contentBase64: Buffer.from("<p>Hi</p>").toString("base64") }];
    const board = await ok("POST", `/api/projects/${s.project.id}/artifacts`, s.ada, { title: "Board", files });

    const written = await document(s, "Per CRONK-D1, one Lane.");
    expect(written.mentions).toEqual([
      { kind: "decision", text: "CRONK-D1", key: "CRONK-D1", decisionId: decision.id, projectId: s.project.id, number: 1 },
      mentionOf(projectLane),
    ]);
    const comment = await ok("POST", `/api/artifacts/${board.id}/comments`, s.ada, { body: "One Lane per column." });
    expect(comment.mentions).toEqual([mentionOf(projectLane)]);
    const onDocument = await ok("POST", `/api/documents/${written.id}/comments`, s.ada, { body: "A Lane each." });
    expect(onDocument.mentions).toEqual([mentionOf(projectLane)]);

    // Indexed again after a rename, the Comment keeps its Project's glossary.
    // Settled between the renames, and compared in any order: indexing again goes by kind and then by random id, so
    // which text was indexed last, and so comes first, is not fixed.
    await ok("PATCH", `/api/terms/${projectLane.id}`, s.ada, { name: "Swimlane", baseVersion: 1 });
    await cronk.jobsSettled();
    await ok("PATCH", `/api/terms/${projectLane.id}`, s.ada, { name: "Lane", baseVersion: 2 });
    await cronk.jobsSettled();
    const lanes = await mentionedIn(s.ada, projectLane.id);
    expect(lanes).toHaveLength(3);
    expect(lanes).toEqual(
      expect.arrayContaining([
        ["document", written.id],
        ["comment", onDocument.id],
        ["comment", comment.id],
      ]),
    );
    expect(await mentionedIn(s.ada, workspaceLane.id)).toEqual([]);
    expect((await document(s, "Per CRONK-D1, one Lane.")).mentions).toHaveLength(2);
  });
});

describe("indexing again as Terms change", () => {
  test("creating, renaming and removing a Term changes which texts mention it", async () => {
    const s = await workspaceWithProject();
    const plan = await document(s, "A Swimlane, then a Lane.");
    const elsewhere = await document(s, "A Swimlane.", null);
    expect(plan.mentions).toEqual([]);

    const term = await workspaceTerm(s, "Swimlane");
    await cronk.jobsSettled();
    expect(await plan.read()).toEqual([mentionOf(term)]);
    expect(await mentionedIn(s.ada, term.id)).toEqual(
      expect.arrayContaining([
        ["document", plan.id],
        ["document", elsewhere.id],
      ]),
    );

    const renamed = await ok("PATCH", `/api/terms/${term.id}`, s.ada, { baseVersion: 1, name: "Lane" });
    await cronk.jobsSettled();
    expect(await plan.read()).toEqual([mentionOf(renamed)]);
    expect(await elsewhere.read()).toEqual([]);
    expect(await mentionedIn(s.ada, term.id)).toEqual([["document", plan.id]]);

    await ok("DELETE", `/api/terms/${term.id}`, s.ada);
    await cronk.jobsSettled();
    expect(await plan.read()).toEqual([]);
  });

  test("a Project Term over a Workspace Term of the same name takes its Project's texts, and gives them back when removed", async () => {
    const s = await workspaceWithProject();
    const workspaceLane = await workspaceTerm(s, "Lane");
    const plan = await document(s, "A Lane.");
    expect(plan.mentions).toEqual([mentionOf(workspaceLane)]);

    const projectLane = await projectTerm(s, "Lane");
    await cronk.jobsSettled();
    expect(await plan.read()).toEqual([mentionOf(projectLane)]);
    expect(await mentionedIn(s.ada, workspaceLane.id)).toEqual([]);

    await ok("DELETE", `/api/terms/${projectLane.id}`, s.ada);
    await cronk.jobsSettled();
    expect(await plan.read()).toEqual([mentionOf(workspaceLane)]);
    expect(await mentionedIn(s.ada, workspaceLane.id)).toEqual([["document", plan.id]]);
  });

  test("the save doesn't wait for indexing again, and a save that keeps the name indexes nothing again", async () => {
    const s = await workspaceWithProject();
    const plan = await document(s, "A Lane.");
    const term = await workspaceTerm(s, "Lane");
    // Created, the Term is listed under Mentioned in only once the texts are indexed again.
    expect(term).toEqual(expect.objectContaining({ mentionedIn: [] }));
    await cronk.jobsSettled();

    const saved = await ok("PATCH", `/api/terms/${term.id}`, s.ada, { baseVersion: 1, definition: "A column." });
    expect(saved.mentionedIn).toEqual([expect.objectContaining({ kind: "document", id: plan.id })]);
  });
});

describe("Mentioned in and Access", () => {
  test("a Term's Mentioned in leaves out the texts the reader can't read", async () => {
    const s = await workspaceWithProject();
    const grace = await addMember(cronk, s.ada.cookie, s.workspace.id, "grace@example.com");
    const secret = await ok("POST", `/api/workspaces/${s.workspace.id}/projects`, s.ada, { name: "Secret", key: "SECRET" });
    await ok("PUT", `/api/projects/${secret.id}/access`, s.ada, { visibility: "private", users: [] });
    const lane = await workspaceTerm(s, "Lane");
    const open = await document(s, "A Lane.");
    const hidden = await document(s, "A hidden Lane.", secret.id);

    expect(await mentionedIn(s.ada, lane.id)).toEqual([
      ["document", hidden.id],
      ["document", open.id],
    ]);
    expect(await mentionedIn({ cookie: grace.cookie }, lane.id)).toEqual([["document", open.id]]);
  });
});

describe("texts written before Term Mentions", () => {
  test("are indexed with Term names once on the next start", async () => {
    const s = await workspaceWithProject();
    const lane = await projectTerm(s, "Lane");
    const plan = await document(s, "A Lane.");
    const ticket = await ok("POST", `/api/projects/${s.project.id}/tickets`, s.ada, { title: "Then", description: "A Lane." });
    // As a Cronk before migration 0066 left them: no Term Mentions recorded, with their indexing still to do.
    await cronk.stage("delete from mentions where target_kind = 'term'");
    await cronk.stage("insert into pending_backfills (name) values ('term-mentions')");
    expect(await plan.read()).toEqual([]);

    await cronk.upgrade();

    expect(await plan.read()).toEqual([mentionOf(lane)]);
    expect(await mentionedIn(s.ada, lane.id)).toEqual(
      expect.arrayContaining([
        ["document", plan.id],
        ["ticket", ticket.id],
      ]),
    );
  });
});
