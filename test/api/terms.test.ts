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

describe("Terms", () => {
  test("a User creates a Term in a Project and reads it at its first Version, saved by them", async () => {
    const { ada, user, project, workspace } = await workspaceWithProject();

    const created = await call("POST", `/api/projects/${project.id}/terms`, ada, {
      name: "Ticket",
      definition: "A unit of work tracked within a Project.",
      avoid: ["Issue", "task"],
    });

    expect(created.status).toBe(201);
    const read = await ok("GET", `/api/terms/${created.json.id}`, ada);
    expect(read).toEqual({
      id: created.json.id,
      workspaceId: workspace.id,
      projectId: project.id,
      name: "Ticket",
      definition: "A unit of work tracked within a Project.",
      avoid: ["Issue", "task"],
      version: {
        number: 1,
        actor: { kind: "user", id: user.id, name: "ada@example.com" },
        savedAt: "2026-01-01T09:00:00.000Z",
      },
    });
  });

  test("each save based on the current Version makes the next Version, recording its Actor", async () => {
    const { ada, project, agent, asAgent } = await workspaceWithProject();
    const term = await ok("POST", `/api/projects/${project.id}/terms`, ada, { name: "Run", definition: "An agent run." });

    cronk.clock.advance(60_000);
    const saved = await ok("PATCH", `/api/terms/${term.id}`, asAgent, { baseVersion: 1, avoid: ["job", "session"] });

    expect(saved).toEqual(
      expect.objectContaining({
        name: "Run",
        definition: "An agent run.",
        avoid: ["job", "session"],
        version: {
          number: 2,
          actor: { kind: "agent", id: agent.id, name: "claude-max" },
          savedAt: "2026-01-01T09:01:00.000Z",
        },
      }),
    );
    expect((await ok("GET", `/api/terms/${term.id}`, ada)).avoid).toEqual(["job", "session"]);
  });

  test("a save based on an outdated Version is refused with the current Version", async () => {
    const { ada, project, agent, asAgent } = await workspaceWithProject();
    const term = await ok("POST", `/api/projects/${project.id}/terms`, ada, { name: "Run", definition: "One." });
    await ok("PATCH", `/api/terms/${term.id}`, asAgent, { baseVersion: 1, definition: "Agent's take." });

    const refused = await call("PATCH", `/api/terms/${term.id}`, ada, { baseVersion: 1, definition: "Ada's take." });

    expect(refused.status).toBe(409);
    expect(refused.json.error).toEqual(
      expect.objectContaining({
        code: "outdated_version",
        current: {
          number: 2,
          name: "Run",
          definition: "Agent's take.",
          avoid: [],
          actor: { kind: "agent", id: agent.id, name: "claude-max" },
          savedAt: "2026-01-01T09:00:00.000Z",
        },
      }),
    );
    expect((await ok("GET", `/api/terms/${term.id}`, ada)).definition).toBe("Agent's take.");
  });

  test("a Term's Versions are listed oldest first, each with what it said", async () => {
    const { ada, user, project, agent, asAgent } = await workspaceWithProject();
    const term = await ok("POST", `/api/projects/${project.id}/terms`, ada, { name: "Runn", definition: "One." });
    cronk.clock.advance(60_000);
    await ok("PATCH", `/api/terms/${term.id}`, asAgent, { baseVersion: 1, name: "Run", avoid: ["job"] });

    const versions = await ok("GET", `/api/terms/${term.id}/versions`, ada);

    expect(versions).toEqual([
      {
        number: 1,
        name: "Runn",
        definition: "One.",
        avoid: [],
        actor: { kind: "user", id: user.id, name: "ada@example.com" },
        savedAt: "2026-01-01T09:00:00.000Z",
      },
      {
        number: 2,
        name: "Run",
        definition: "One.",
        avoid: ["job"],
        actor: { kind: "agent", id: agent.id, name: "claude-max" },
        savedAt: "2026-01-01T09:01:00.000Z",
      },
    ]);
  });
});

describe("Project and Workspace Terms", () => {
  test("a Project's Terms and the Workspace's are listed apart, each by name ignoring case", async () => {
    const { ada, workspace, project, asAgent } = await workspaceWithProject();
    const projectTerms = `/api/projects/${project.id}/terms`;
    const workspaceTerms = `/api/workspaces/${workspace.id}/terms`;
    await ok("POST", projectTerms, ada, { name: "Ticket" });
    await ok("POST", projectTerms, asAgent, { name: "board" });
    await ok("POST", workspaceTerms, ada, { name: "Workspace" });
    const user = await call("POST", workspaceTerms, asAgent, { name: "User" });

    expect(user.status).toBe(201);
    expect(user.json).toEqual(expect.objectContaining({ workspaceId: workspace.id, projectId: null }));
    const names = async (path: string) => (await ok("GET", path, ada)).map((t: { name: string }) => t.name);
    expect(await names(projectTerms)).toEqual(["board", "Ticket"]);
    expect(await names(workspaceTerms)).toEqual(["User", "Workspace"]);
  });

  test("a name is unique ignoring case among a Project's Terms and among the Workspace's", async () => {
    const { ada, workspace, project, asAgent } = await workspaceWithProject();
    const other = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Other", key: "OTHER" });
    const projectTerms = `/api/projects/${project.id}/terms`;
    const workspaceTerms = `/api/workspaces/${workspace.id}/terms`;
    await ok("POST", projectTerms, ada, { name: "Ticket" });
    const run = await ok("POST", projectTerms, ada, { name: "Run" });
    await ok("POST", workspaceTerms, ada, { name: "Agent" });

    const refused = [
      await call("POST", projectTerms, asAgent, { name: "ticket" }),
      await call("POST", projectTerms, ada, { name: "  TICKET " }),
      await call("PATCH", `/api/terms/${run.id}`, asAgent, { baseVersion: 1, name: "Ticket" }),
      await call("POST", workspaceTerms, asAgent, { name: "AGENT" }),
    ];

    for (const response of refused) {
      expect(response.status).toBe(409);
      expect(response.json.error).toEqual(
        expect.objectContaining({ code: "term_name_taken", rule: expect.any(String), advice: expect.any(String) }),
      );
    }
    expect((await call("POST", `/api/projects/${other.id}/terms`, ada, { name: "ticket" })).status).toBe(201);
    expect((await call("POST", workspaceTerms, ada, { name: "Ticket" })).status).toBe(201);
    expect((await call("POST", projectTerms, ada, { name: "Agent" })).status).toBe(201);
    expect((await ok("PATCH", `/api/terms/${run.id}`, ada, { baseVersion: 1, name: "RUN" })).name).toBe("RUN");
  });
});
