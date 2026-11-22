import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addMember, setUp, signIn } from "../harness/flows.js";
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
      ticketId: null,
      runId: null,
      parentId: null,
      position: 0,
      title: "Architecture",
      slug: `architecture-${created.json.id.slice(0, 8)}`,
      body: "# How it fits together",
      version: {
        number: 1,
        title: "Architecture",
        actor: { kind: "user", id: user.id, name: "ada@example.com" },
        savedAt: "2026-01-01T09:00:00.000Z",
      },
      mentions: [],
      comments: [],
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

describe("deleting a Document", () => {
  test("a User deletes a Document, and its siblings close the gap", async () => {
    const { ada, project } = await workspaceWithProject();
    const tree = `/api/projects/${project.id}/documents`;
    await ok("POST", tree, ada, { title: "Overview" });
    const draft = await ok("POST", tree, ada, { title: "Draft" });
    await ok("POST", tree, ada, { title: "Setup" });

    const deleted = await call("DELETE", `/api/documents/${draft.id}`, ada);

    expect(deleted.status).toBe(204);
    expect((await call("GET", `/api/documents/${draft.id}`, ada)).status).toBe(404);
    const documents = await ok("GET", tree, ada);
    expect(documents.map((d: { title: string; position: number }) => [d.title, d.position])).toEqual([
      ["Overview", 0],
      ["Setup", 1],
    ]);
  });

  test("deleting a Document with children is refused until they're moved or deleted", async () => {
    const { ada, project } = await workspaceWithProject();
    const tree = `/api/projects/${project.id}/documents`;
    const guides = await ok("POST", tree, ada, { title: "Guides" });
    const setup = await ok("POST", tree, ada, { title: "Setup", parentId: guides.id });

    const refused = await call("DELETE", `/api/documents/${guides.id}`, ada);

    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe("document_has_children");
    await ok("PATCH", `/api/documents/${setup.id}`, ada, { parentId: null });
    expect((await call("DELETE", `/api/documents/${guides.id}`, ada)).status).toBe(204);
    expect(await treeOf(tree, ada)).toEqual(["Setup"]);
  });
});

describe("Project and Workspace page trees", () => {
  test("the Workspace has its own page tree, separate from each Project's", async () => {
    const { ada, workspace, project, asAgent } = await workspaceWithProject();
    const workspaceTree = `/api/workspaces/${workspace.id}/documents`;
    const projectTree = `/api/projects/${project.id}/documents`;

    const handbook = await call("POST", workspaceTree, asAgent, { title: "Handbook" });
    await ok("POST", projectTree, ada, { title: "Architecture" });

    expect(handbook.status).toBe(201);
    expect(handbook.json).toEqual(expect.objectContaining({ workspaceId: workspace.id, projectId: null, parentId: null }));
    expect(await treeOf(workspaceTree, ada)).toEqual(["Handbook"]);
    expect(await treeOf(projectTree, asAgent)).toEqual(["Architecture"]);
  });

  test("a Document's parent is always in its own page tree", async () => {
    const { ada, workspace, project } = await workspaceWithProject();
    const other = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Other", key: "OTHER" });
    const handbook = await ok("POST", `/api/workspaces/${workspace.id}/documents`, ada, { title: "Handbook" });
    const elsewhere = await ok("POST", `/api/projects/${other.id}/documents`, ada, { title: "Elsewhere" });
    const architecture = await ok("POST", `/api/projects/${project.id}/documents`, ada, { title: "Architecture" });

    const created = await call("POST", `/api/projects/${project.id}/documents`, ada, { title: "Setup", parentId: handbook.id });
    const moved = await call("PATCH", `/api/documents/${architecture.id}`, ada, { parentId: elsewhere.id });
    const movedUp = await call("PATCH", `/api/documents/${handbook.id}`, ada, { parentId: architecture.id });

    for (const refused of [created, moved, movedUp]) {
      expect([refused.status, refused.json.error.code]).toEqual([409, "parent_outside_tree"]);
    }
  });
});

describe("refusals", () => {
  test("refused, changing nothing: another Workspace's member or Agent, an Agent's delete, a read-only token's writes, and a save naming no Version", async () => {
    const { ada, workspace, project, agent, asAgent } = await workspaceWithProject();
    const document = await ok("POST", `/api/projects/${project.id}/documents`, asAgent, { title: "Secret plan" });
    const handbook = await ok("POST", `/api/workspaces/${workspace.id}/documents`, ada, { title: "Handbook" });
    const second = await ok("POST", "/api/workspaces", ada, { name: "Bob's Workspace" });
    const bob = await addMember(cronk, ada.cookie, second.id, "bob@example.com");
    const theirs = await ok("POST", `/api/workspaces/${second.id}/documents`, bob, { title: "Bob's notes" });
    const bobsAgent = await ok("POST", `/api/workspaces/${second.id}/agents`, bob, { name: "bob-bot" });
    const { secret: bobsSecret } = await ok("POST", `/api/agents/${bobsAgent.id}/tokens`, bob, { name: "laptop", access: "full" });
    const asBobsAgent = { headers: { authorization: `Bearer ${bobsSecret}` } };
    const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "reader", access: "read" });
    const reader = { headers: { authorization: `Bearer ${secret}` } };
    // A read-only token reads Documents.
    expect((await ok("GET", `/api/documents/${document.id}`, reader)).title).toBe("Secret plan");

    const readOnly = expect.objectContaining({ code: "read_only_token" });
    const refusals: [string, As, string, string, unknown, number, unknown?][] = [
      [
        "an Agent",
        asAgent,
        "DELETE",
        `/api/documents/${document.id}`,
        undefined,
        403,
        expect.objectContaining({ code: "agent_not_allowed", rule: expect.stringContaining("Only a User deletes a Document") }),
      ],
      ["a read-only token", reader, "POST", `/api/projects/${project.id}/documents`, { title: "Mine" }, 403, readOnly],
      ["a read-only token", reader, "PATCH", `/api/documents/${document.id}`, { baseVersion: 1, body: "Mine." }, 403, readOnly],
      ["a read-only token", reader, "PATCH", `/api/documents/${document.id}`, { position: 0 }, 403, readOnly],
      // A save must name the Version it's based on.
      ["Ada", ada, "PATCH", `/api/documents/${document.id}`, { body: "No base." }, 400, expect.objectContaining({ code: "base_version_needed" })],
    ];
    // Nothing crosses Workspaces: another Workspace's Documents answer as not found.
    for (const [who, as] of [["Bob", { cookie: bob.cookie }], ["Bob's Agent", asBobsAgent]] as const) {
      for (const [method, path, body] of [
        ["GET", `/api/documents/${document.id}`],
        ["GET", `/api/documents/${document.id}/versions`],
        ["GET", `/api/documents/${document.id}/versions/1`],
        ["GET", `/api/documents/${document.id}/versions/compare?from=1&to=1`],
        ["PATCH", `/api/documents/${document.id}`, { baseVersion: 1, body: "Mine now." }],
        ["GET", `/api/documents/${document.id}/sections?section=Plan`],
        ["PUT", `/api/documents/${document.id}/sections`, { section: "Plan", baseVersion: 1, body: "# Plan\nMine now." }],
        ["DELETE", `/api/documents/${document.id}`],
        ["GET", `/api/projects/${project.id}/documents`],
        ["POST", `/api/projects/${project.id}/documents`, { title: "Planted" }],
        ["GET", `/api/workspaces/${workspace.id}/documents`],
        ["POST", `/api/workspaces/${workspace.id}/documents`, { title: "Planted" }],
      ] as const) {
        refusals.push([who, as, method, path, body, 404]);
      }
    }
    for (const [who, as, method, path, body, status, error] of refusals) {
      const refused = await call(method, path, as, body);
      expect(refused.status, `${who}: ${method} ${path}`).toBe(status);
      if (error) expect(refused.json.error, `${who}: ${method} ${path}`).toEqual(error);
    }
    const intoTheirs = await call("PATCH", `/api/documents/${theirs.id}`, bob, { parentId: handbook.id });
    expect(intoTheirs.status).toBe(409);

    expect(await treeOf(`/api/projects/${project.id}/documents`, asAgent)).toEqual(["Secret plan"]);
    expect(await treeOf(`/api/workspaces/${workspace.id}/documents`, ada)).toEqual(["Handbook"]);
    expect(await treeOf(`/api/workspaces/${second.id}/documents`, bob)).toEqual(["Bob's notes"]);
    expect((await ok("GET", `/api/documents/${document.id}`, ada)).version.number).toBe(1);
  });
});

describe("writes to one page tree at once", () => {
  test("deleting, moving, saving and creating Documents at the same time each succeed or are refused, never fail", async () => {
    const { ada, project, asAgent } = await workspaceWithProject();
    const tree = `/api/projects/${project.id}/documents`;
    const documents = [];
    for (let i = 0; i < 6; i++) documents.push(await ok("POST", tree, ada, { title: `Page ${i}` }));
    const [first, second, third, fourth, fifth, sixth] = documents;

    const responses = await Promise.all([
      call("DELETE", `/api/documents/${first.id}`, ada),
      call("POST", tree, asAgent, { title: "New", parentId: first.id, position: 0 }),
      call("PATCH", `/api/documents/${second.id}`, asAgent, { position: 0 }),
      call("POST", tree, asAgent, { title: "Top", position: 0 }),
      call("DELETE", `/api/documents/${third.id}`, ada),
      call("PATCH", `/api/documents/${fourth.id}`, ada, { parentId: third.id }),
      call("PATCH", `/api/documents/${fifth.id}`, asAgent, { baseVersion: 1, body: "Saved." }),
      call("PATCH", `/api/documents/${sixth.id}`, ada, { parentId: fifth.id, position: 0 }),
      call("DELETE", `/api/documents/${fifth.id}`, ada),
    ]);

    for (const response of responses) expect(response.status, JSON.stringify(response.json)).toBeLessThan(500);
    const after: { parentId: string | null; position: number }[] = await ok("GET", tree, ada);
    const places = new Map<string | null, number[]>();
    for (const d of after) places.set(d.parentId, [...(places.get(d.parentId) ?? []), d.position]);
    for (const positions of places.values()) expect(positions).toEqual(positions.map((_, i) => i));
  });
});
