import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

let cronk: StartedCronk;
beforeEach(async () => {
  cronk = await startCronk();
});
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

/** Ada's Workspace with a Project CRONK, and a full token of her Agent `claude-max`. */
async function workspaceWithProject() {
  const { workspace, user } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const agent = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "laptop", access: "full" });
  const asAgent = { headers: { authorization: `Bearer ${secret}` } };
  return { workspace, user, ada, project, agent, asAgent };
}

describe("Documents", () => {
  test("a User creates a Document in a Project's page tree and reads it at its first Version, saved by them", async () => {
    const { ada, user, project, workspace } = await workspaceWithProject();

    const created = await call("POST", `/api/projects/${project.id}/documents`, ada, {
      title: "Architecture",
      body: "# How it fits together",
    });

    expect(created.status).toBe(201);
    const read = await ok("GET", `/api/documents/${created.json.id}`, ada);
    expect(read).toEqual({
      id: created.json.id,
      workspaceId: workspace.id,
      projectId: project.id,
      parentId: null,
      position: 0,
      title: "Architecture",
      body: "# How it fits together",
      version: {
        number: 1,
        title: "Architecture",
        actor: { kind: "user", id: user.id, name: "ada@example.com" },
        savedAt: "2026-01-01T09:00:00.000Z",
      },
    });
  });

  test("each save based on the current Version makes the next Version, recording its Actor", async () => {
    const { ada, project, agent, asAgent } = await workspaceWithProject();
    const document = await ok("POST", `/api/projects/${project.id}/documents`, ada, { title: "Plan", body: "One." });

    cronk.clock.advance(60_000);
    const saved = await ok("PATCH", `/api/documents/${document.id}`, asAgent, { baseVersion: 1, body: "One. Two." });

    expect(saved).toEqual(
      expect.objectContaining({
        title: "Plan",
        body: "One. Two.",
        version: {
          number: 2,
          title: "Plan",
          actor: { kind: "agent", id: agent.id, name: "claude-max" },
          savedAt: "2026-01-01T09:01:00.000Z",
        },
      }),
    );
    expect((await ok("GET", `/api/documents/${document.id}`, ada)).body).toBe("One. Two.");
  });

  test("a save based on an outdated Version is refused with the current Version", async () => {
    const { ada, project, agent, asAgent } = await workspaceWithProject();
    const document = await ok("POST", `/api/projects/${project.id}/documents`, ada, { title: "Plan", body: "One." });
    await ok("PATCH", `/api/documents/${document.id}`, asAgent, { baseVersion: 1, body: "Agent's take." });

    const refused = await call("PATCH", `/api/documents/${document.id}`, ada, { baseVersion: 1, body: "Ada's take." });

    expect(refused.status).toBe(409);
    expect(refused.json.error).toEqual(
      expect.objectContaining({
        code: "outdated_version",
        current: {
          number: 2,
          title: "Plan",
          body: "Agent's take.",
          actor: { kind: "agent", id: agent.id, name: "claude-max" },
          savedAt: "2026-01-01T09:00:00.000Z",
        },
      }),
    );
    expect((await ok("GET", `/api/documents/${document.id}`, ada)).body).toBe("Agent's take.");
  });

  test("earlier Versions are listed, oldest first, and each can be read", async () => {
    const { ada, user, project, agent, asAgent } = await workspaceWithProject();
    const document = await ok("POST", `/api/projects/${project.id}/documents`, ada, { title: "Plan", body: "One." });
    cronk.clock.advance(60_000);
    await ok("PATCH", `/api/documents/${document.id}`, asAgent, { baseVersion: 1, title: "The plan", body: "Two." });

    const versions = await ok("GET", `/api/documents/${document.id}/versions`, ada);
    const first = await ok("GET", `/api/documents/${document.id}/versions/1`, asAgent);

    expect(versions).toEqual([
      { number: 1, title: "Plan", actor: { kind: "user", id: user.id, name: "ada@example.com" }, savedAt: "2026-01-01T09:00:00.000Z" },
      { number: 2, title: "The plan", actor: { kind: "agent", id: agent.id, name: "claude-max" }, savedAt: "2026-01-01T09:01:00.000Z" },
    ]);
    expect(first).toEqual({ ...versions[0], body: "One." });
    expect((await call("GET", `/api/documents/${document.id}/versions/3`, ada)).status).toBe(404);
  });

  test("two Versions compare line by line", async () => {
    const { ada, project } = await workspaceWithProject();
    const document = await ok("POST", `/api/projects/${project.id}/documents`, ada, {
      title: "Plan",
      body: "# Plan\nBuild it.\nShip it.",
    });
    await ok("PATCH", `/api/documents/${document.id}`, ada, {
      baseVersion: 1,
      title: "The plan",
      body: "# Plan\nDesign it.\nBuild it.\nShip it soon.",
    });

    const compared = await ok("GET", `/api/documents/${document.id}/versions/compare?from=1&to=2`, ada);

    expect(compared).toEqual({
      from: expect.objectContaining({ number: 1, title: "Plan" }),
      to: expect.objectContaining({ number: 2, title: "The plan" }),
      lines: [
        { change: "same", text: "# Plan" },
        { change: "added", text: "Design it." },
        { change: "same", text: "Build it." },
        { change: "removed", text: "Ship it." },
        { change: "added", text: "Ship it soon." },
      ],
    });
  });

  test("a save must name the Version it's based on", async () => {
    const { ada, project } = await workspaceWithProject();
    const document = await ok("POST", `/api/projects/${project.id}/documents`, ada, { title: "Plan" });

    const refused = await call("PATCH", `/api/documents/${document.id}`, ada, { body: "No base." });

    expect(refused.status).toBe(400);
    expect(refused.json.error.code).toBe("base_version_needed");
  });
});

/** A page tree as `title` lines, each indented two spaces per level below the top, in tree order. */
async function treeOf(path: string, as: As) {
  const documents: { id: string; parentId: string | null; position: number; title: string }[] = await ok("GET", path, as);
  const depth = new Map<string | null, number>([[null, -1]]);
  return documents.map((d) => {
    depth.set(d.id, depth.get(d.parentId)! + 1);
    return `${"  ".repeat(depth.get(d.id)!)}${d.title}`;
  });
}

describe("the page tree", () => {
  test("Documents are listed in tree order: each under its parent, siblings by their place", async () => {
    const { ada, project } = await workspaceWithProject();
    const tree = `/api/projects/${project.id}/documents`;
    const guides = await ok("POST", tree, ada, { title: "Guides" });
    await ok("POST", tree, ada, { title: "Decisions" });
    await ok("POST", tree, ada, { title: "Setup", parentId: guides.id });
    await ok("POST", tree, ada, { title: "Overview", position: 0 });
    await ok("POST", tree, ada, { title: "Testing", parentId: guides.id, position: 0 });

    expect(await treeOf(tree, ada)).toEqual(["Overview", "Guides", "  Testing", "  Setup", "Decisions"]);
  });

  test("moving a Document changes its parent and place without making a Version", async () => {
    const { ada, project, asAgent } = await workspaceWithProject();
    const tree = `/api/projects/${project.id}/documents`;
    const guides = await ok("POST", tree, ada, { title: "Guides" });
    const setup = await ok("POST", tree, ada, { title: "Setup" });
    await ok("POST", tree, ada, { title: "Testing", parentId: guides.id });
    await ok("POST", tree, ada, { title: "Decisions" });

    const moved = await ok("PATCH", `/api/documents/${setup.id}`, asAgent, { parentId: guides.id, position: 0 });

    expect(moved).toEqual(expect.objectContaining({ parentId: guides.id, position: 0 }));
    expect(moved.version.number).toBe(1);
    expect(await treeOf(tree, ada)).toEqual(["Guides", "  Setup", "  Testing", "Decisions"]);

    await ok("PATCH", `/api/documents/${setup.id}`, ada, { parentId: null });
    expect(await treeOf(tree, ada)).toEqual(["Guides", "  Testing", "Decisions", "Setup"]);
    await ok("PATCH", `/api/documents/${setup.id}`, ada, { position: 1 });
    expect(await treeOf(tree, ada)).toEqual(["Guides", "  Testing", "Setup", "Decisions"]);
  });

  test("renaming a Document saves its next Version, which the tree shows", async () => {
    const { ada, project } = await workspaceWithProject();
    const tree = `/api/projects/${project.id}/documents`;
    const document = await ok("POST", tree, ada, { title: "Setpu", body: "Run it." });

    const renamed = await ok("PATCH", `/api/documents/${document.id}`, ada, { baseVersion: 1, title: "Setup" });

    expect(renamed).toEqual(expect.objectContaining({ title: "Setup", body: "Run it." }));
    expect(renamed.version.number).toBe(2);
    expect(await treeOf(tree, ada)).toEqual(["Setup"]);
  });

  test("a Document can't move under itself or one of its own descendants", async () => {
    const { ada, project } = await workspaceWithProject();
    const tree = `/api/projects/${project.id}/documents`;
    const guides = await ok("POST", tree, ada, { title: "Guides" });
    const setup = await ok("POST", tree, ada, { title: "Setup", parentId: guides.id });

    const underItself = await call("PATCH", `/api/documents/${guides.id}`, ada, { parentId: guides.id });
    const underChild = await call("PATCH", `/api/documents/${guides.id}`, ada, { parentId: setup.id });

    expect([underItself.status, underItself.json.error.code]).toEqual([409, "document_cycle"]);
    expect([underChild.status, underChild.json.error.code]).toEqual([409, "document_cycle"]);
    expect(await treeOf(tree, ada)).toEqual(["Guides", "  Setup"]);
  });
});
