import { afterEach, describe, expect, test } from "vitest";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

/**
 * Mentions in the editor (CRONK-23): a draft's Mentions, found as they would be once saved in its place, and what the
 * Mention picker offers for the word being typed; both only what the writer may read.
 */

let cronk: StartedCronk;
afterEach(async () => {
  await cronk?.stop();
});

interface As {
  cookie?: string;
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

/** Ada with a Project CRONK holding two Tickets, a Decision and a Term, and Grace, who can't read a private SECRET. */
async function setting() {
  cronk = await startCronk();
  const { workspace } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const grace = { cookie: (await addMember(cronk, ada.cookie, workspace.id, "grace@example.com")).cookie };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const secret = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Secret", key: "SECRET" });
  await ok("PUT", `/api/projects/${secret.id}/access`, ada, { visibility: "private", users: [] });
  const first = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "First" });
  const second = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Second" });
  const hidden = await ok("POST", `/api/projects/${secret.id}/tickets`, ada, { title: "Hidden" });
  const decision = await ok("POST", `/api/projects/${project.id}/decisions`, ada, { title: "Use Postgres" });
  const own = await ok("POST", `/api/workspaces/${workspace.id}/decisions`, ada, { title: "One Workspace" });
  const lane = await ok("POST", `/api/projects/${project.id}/terms`, ada, { name: "Lane", definition: "" });
  const landing = await ok("POST", `/api/workspaces/${workspace.id}/terms`, ada, { name: "Landing page", definition: "" });
  return { workspace, ada, grace, project, secret, first, second, hidden, decision, own, lane, landing };
}

describe("a draft's Mentions", () => {
  test("are found as the saved text's would be, only what the writer may read", async () => {
    const s = await setting();
    const path = `/api/workspaces/${s.workspace.id}/mentions`;
    const markdown = "See cronk-2, SECRET-1, CRONK-D1, D1 and `CRONK-1`, on the Lane by the Landing page. CRONK-99 isn't.";

    const forAda = await ok("POST", path, s.ada, { markdown, project: s.project.id });
    expect(forAda).toEqual([
      { kind: "ticket", text: "cronk-2", key: "CRONK-2", ticketId: s.second.id },
      { kind: "ticket", text: "SECRET-1", key: "SECRET-1", ticketId: s.hidden.id },
      expect.objectContaining({ kind: "decision", text: "CRONK-D1", key: "CRONK-D1", decisionId: s.decision.id }),
      expect.objectContaining({ kind: "decision", text: "D1", key: "D1", decisionId: s.own.id, projectId: null }),
      { kind: "term", text: "Lane", termId: s.lane.id, name: "Lane", projectId: s.project.id },
      { kind: "term", text: "Landing page", termId: s.landing.id, name: "Landing page", projectId: null },
    ]);

    const forGrace = await ok("POST", path, s.grace, { markdown, project: s.project.id });
    expect(forGrace.map((m: { text: string }) => m.text)).toEqual(["cronk-2", "CRONK-D1", "D1", "Lane", "Landing page"]);

    // The Workspace's own text takes the Workspace's glossary, without the Project's Terms.
    const ownText = await ok("POST", path, s.ada, { markdown });
    expect(ownText.filter((m: { kind: string }) => m.kind === "term").map((m: { text: string }) => m.text)).toEqual(["Landing page"]);
  });

  test("a Project of another Workspace, or one the writer can't read, is not found", async () => {
    const s = await setting();
    const refused = await call("POST", `/api/workspaces/${s.workspace.id}/mentions`, s.grace, { markdown: "SECRET-1", project: s.secret.id });
    expect(refused.status).toBe(404);
  });
});

describe("the Mention picker", () => {
  const offered = async (s: Awaited<ReturnType<typeof setting>>, as: As, q: string, project?: string) => {
    const query = new URLSearchParams({ q, ...(project ? { project } : {}) });
    const found = await ok("GET", `/api/workspaces/${s.workspace.id}/mention-candidates?${query}`, as);
    return found.map((c: { kind: string; text: string }) => `${c.kind} ${c.text}`);
  };

  test("offers a Project's Tickets and Decisions for its key, the exact number first", async () => {
    const s = await setting();
    expect(await offered(s, s.ada, "CRONK-", s.project.id)).toEqual(["ticket CRONK-2", "ticket CRONK-1", "decision CRONK-D1"]);
    expect(await offered(s, s.ada, "cronk-1", s.project.id)).toEqual(["ticket CRONK-1"]);
    expect(await offered(s, s.ada, "CRONK", s.project.id)).toEqual(["ticket CRONK-2", "ticket CRONK-1", "decision CRONK-D1"]);
    expect(await offered(s, s.ada, "CRONK-D", s.project.id)).toEqual(["decision CRONK-D1"]);
    expect(await offered(s, s.ada, "D1", s.project.id)).toEqual(["decision D1"]);
    // A key in small letters alone is a word, not a key.
    expect(await offered(s, s.ada, "cronk", s.project.id)).toEqual([]);
  });

  test("offers the Terms of the place's glossary by the start of their name, with its capitalisation", async () => {
    const s = await setting();
    expect(await offered(s, s.ada, "La", s.project.id)).toEqual(["term Lane", "term Landing page"]);
    expect(await offered(s, s.ada, "La")).toEqual(["term Landing page"]);
    expect(await offered(s, s.ada, "la", s.project.id)).toEqual([]);
    expect(await offered(s, s.ada, "L", s.project.id)).toEqual([]);
  });

  test("offers only what the writer may read", async () => {
    const s = await setting();
    expect(await offered(s, s.ada, "SECRET-", s.project.id)).toEqual(["ticket SECRET-1"]);
    expect(await offered(s, s.grace, "SECRET-", s.project.id)).toEqual([]);
  });
});
