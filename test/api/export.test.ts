import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { setUp, signIn } from "../harness/flows.js";
import { unzip } from "../harness/zip.js";
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
  return { status: response.status, json: await response.json() };
}

async function ok(method: string, path: string, as: As, body?: unknown) {
  const response = await call(method, path, as, body);
  expect(response.status, `${method} ${path}: ${JSON.stringify(response.json)}`).toBeLessThan(300);
  return response.json;
}

/** Ada's Workspace with a Project CRONK. */
async function workspaceWithProject() {
  const { workspace } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  return { workspace, ada, project };
}

describe("Exporting knowledge", () => {
  test("a Project's GLOSSARY.md holds the Workspace's Terms with the Project's on top, alphabetical", async () => {
    const { workspace, ada, project } = await workspaceWithProject();
    await ok("POST", `/api/workspaces/${workspace.id}/terms`, ada, {
      name: "Ticket",
      definition: "A unit of work tracked within a Project.",
      avoid: ["Issue", "task"],
    });
    await ok("POST", `/api/workspaces/${workspace.id}/terms`, ada, {
      name: "Run",
      definition: "One agent execution Cronk starts for one Ticket.",
      avoid: ["job"],
    });
    await ok("POST", `/api/projects/${project.id}/terms`, ada, {
      name: "run",
      definition: "In this Project: one Claude Code session on a Ticket.\n\nIt ends with an Outcome.",
      avoid: [],
    });
    await ok("POST", `/api/projects/${project.id}/terms`, ada, { name: "Board", definition: "The Statuses as columns.", avoid: ["kanban"] });

    const exported = await ok("GET", `/api/projects/${project.id}/export`, ada);

    expect(exported.files[0]).toEqual({
      path: "GLOSSARY.md",
      content:
        "# Glossary\n\n" +
        "**Board**:\nThe Statuses as columns.\n_Avoid_: kanban\n\n" +
        "**run**:\nIn this Project: one Claude Code session on a Ticket.\n\nIt ends with an Outcome.\n\n" +
        "**Ticket**:\nA unit of work tracked within a Project.\n_Avoid_: Issue, task\n",
    });
  });

  test("a Project's export holds docs/adr/NNNN-<slug>.md for each of its own Decisions, by number, with its status", async () => {
    const { workspace, ada, project } = await workspaceWithProject();
    await ok("POST", `/api/workspaces/${workspace.id}/decisions`, ada, { title: "One Workspace per team", body: "Ours." });
    const postgres = await ok("POST", `/api/projects/${project.id}/decisions`, ada, {
      title: "Use Postgres",
      body: "## Context\n\nWe need a database.",
      status: "accepted",
    });
    const sqlite = await ok("POST", `/api/projects/${project.id}/decisions`, ada, {
      title: "Use SQLite, not Postgres!",
      body: "Smaller.",
    });
    await ok("PATCH", `/api/decisions/${postgres.id}`, ada, {
      baseVersion: 1,
      status: "superseded",
      supersededById: sqlite.id,
    });
    await ok("POST", `/api/projects/${project.id}/decisions`, ada, { title: "Café crème: ünïcode & co.", status: "rejected" });

    const exported = await ok("GET", `/api/projects/${project.id}/export`, ada);

    expect(exported.files.slice(1)).toEqual([
      {
        path: "docs/adr/0001-use-postgres.md",
        content:
          "# Use Postgres\n\n" +
          "Status: superseded by [0002 Use SQLite, not Postgres!](0002-use-sqlite-not-postgres.md)\n\n" +
          "## Context\n\nWe need a database.\n",
      },
      {
        path: "docs/adr/0002-use-sqlite-not-postgres.md",
        content: "# Use SQLite, not Postgres!\n\nStatus: proposed\n\nSmaller.\n",
      },
      {
        path: "docs/adr/0003-cafe-creme-unicode-co.md",
        content: "# Café crème: ünïcode & co.\n\nStatus: rejected\n",
      },
    ]);
  });

  test("the Workspace's export holds its own Terms and Decisions, none of its Projects'", async () => {
    const { workspace, ada, project } = await workspaceWithProject();
    await ok("POST", `/api/workspaces/${workspace.id}/terms`, ada, { name: "Ticket", definition: "A unit of work." });
    await ok("POST", `/api/projects/${project.id}/terms`, ada, { name: "Board", definition: "The Statuses as columns." });
    await ok("POST", `/api/projects/${project.id}/decisions`, ada, { title: "Use Postgres" });
    await ok("POST", `/api/workspaces/${workspace.id}/decisions`, ada, { title: "One Workspace per team", status: "accepted" });

    const exported = await ok("GET", `/api/workspaces/${workspace.id}/export`, ada);

    expect(exported).toEqual({
      files: [
        { path: "GLOSSARY.md", content: "# Glossary\n\n**Ticket**:\nA unit of work.\n" },
        { path: "docs/adr/0001-one-workspace-per-team.md", content: "# One Workspace per team\n\nStatus: accepted\n" },
      ],
    });
  });

  test("an empty Project exports a GLOSSARY.md with no Terms and no Decisions", async () => {
    const { ada, project } = await workspaceWithProject();

    expect(await ok("GET", `/api/projects/${project.id}/export`, ada)).toEqual({
      files: [{ path: "GLOSSARY.md", content: "# Glossary\n" }],
    });
  });

  test("a Project's export downloads as a zip of the same files, named after its key", async () => {
    const { ada, project } = await workspaceWithProject();
    await ok("POST", `/api/projects/${project.id}/terms`, ada, { name: "Board", definition: "The Statuses as columns." });
    await ok("POST", `/api/projects/${project.id}/decisions`, ada, { title: "Use Postgres", body: "We need a database." });

    const response = await cronk.request("GET", `/api/projects/${project.id}/export.zip`, ada);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toBe(
      "attachment; filename=\"CRONK-knowledge.zip\"; filename*=UTF-8''CRONK-knowledge.zip",
    );
    expect(unzip(Buffer.from(await response.arrayBuffer()))).toEqual(
      new Map([
        ["GLOSSARY.md", "# Glossary\n\n**Board**:\nThe Statuses as columns.\n"],
        ["docs/adr/0001-use-postgres.md", "# Use Postgres\n\nStatus: proposed\n\nWe need a database.\n"],
      ]),
    );
  });

  test("the Workspace's export downloads as a zip named after the Workspace", async () => {
    const { workspace, ada } = await workspaceWithProject();
    await ok("POST", `/api/workspaces/${workspace.id}/terms`, ada, { name: "Ticket", definition: "A unit of work." });

    const response = await cronk.request("GET", `/api/workspaces/${workspace.id}/export.zip`, ada);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      "attachment; filename=\"Ada-s-Workspace-knowledge.zip\"; filename*=UTF-8''Ada-s-Workspace-knowledge.zip",
    );
    expect(unzip(Buffer.from(await response.arrayBuffer()))).toEqual(
      new Map([["GLOSSARY.md", "# Glossary\n\n**Ticket**:\nA unit of work.\n"]]),
    );
  });

  test("nobody exports a Project or Workspace outside their view", async () => {
    const { workspace, project } = await workspaceWithProject();
    const other = await ok("POST", "/api/workspaces", { cookie: await signIn(cronk) }, { name: "Elsewhere" });
    expect((await call("GET", `/api/projects/${project.id}/export`, {})).status).toBe(401);

    const agent = await ok("POST", `/api/workspaces/${other.id}/agents`, { cookie: await signIn(cronk) }, { name: "outsider" });
    const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, { cookie: await signIn(cronk) }, { name: "t", access: "full" });
    const outsider = { headers: { authorization: `Bearer ${secret}` } };
    expect((await call("GET", `/api/projects/${project.id}/export`, outsider)).status).toBe(404);
    expect((await call("GET", `/api/workspaces/${workspace.id}/export`, outsider)).status).toBe(404);
  });
});
