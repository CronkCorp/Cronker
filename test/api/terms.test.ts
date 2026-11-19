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
