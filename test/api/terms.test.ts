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

  test("one of a Workspace Term's Versions is read by its number", async () => {
    const { ada, user, workspace, asAgent } = await workspaceWithProject();
    const term = await ok("POST", `/api/workspaces/${workspace.id}/terms`, ada, { name: "Brief", definition: "Instructions.", avoid: ["Prompt"] });
    await ok("PATCH", `/api/terms/${term.id}`, asAgent, { baseVersion: 1, definition: "The instructions a Run starts from." });

    const first = await ok("GET", `/api/terms/${term.id}/versions/1`, asAgent);

    expect(first).toEqual({
      number: 1,
      name: "Brief",
      definition: "Instructions.",
      avoid: ["Prompt"],
      actor: { kind: "user", id: user.id, name: "ada@example.com" },
      savedAt: "2026-01-01T09:00:00.000Z",
    });
  });

  test("two of a Project Term's Versions are compared: both, with their definitions and words to avoid line by line", async () => {
    const { ada, project, asAgent } = await workspaceWithProject();
    const term = await ok("POST", `/api/projects/${project.id}/terms`, ada, {
      name: "Brief",
      definition: "Instructions.\nOne per Run.",
      avoid: ["Prompt", "task"],
    });
    await ok("PATCH", `/api/terms/${term.id}`, asAgent, { baseVersion: 1, name: "Run brief", avoid: ["Prompt", "system prompt"] });
    await ok("PATCH", `/api/terms/${term.id}`, ada, { baseVersion: 2, definition: "Instructions.\nEach Run has its own." });

    const compared = await ok("GET", `/api/terms/${term.id}/versions/compare?from=1&to=3`, asAgent);
    const second = await ok("GET", `/api/terms/${term.id}/versions/2`, ada);

    expect(compared.from).toEqual(expect.objectContaining({ number: 1, name: "Brief", definition: "Instructions.\nOne per Run." }));
    expect(compared.to).toEqual(expect.objectContaining({ number: 3, name: "Run brief", avoid: ["Prompt", "system prompt"] }));
    expect(second).toEqual(expect.objectContaining({ number: 2, name: "Run brief", definition: "Instructions.\nOne per Run." }));
    expect(compared.lines).toEqual([
      { change: "same", text: "Instructions." },
      { change: "removed", text: "One per Run." },
      { change: "added", text: "Each Run has its own." },
    ]);
    expect(compared.avoid).toEqual([
      { change: "same", text: "Prompt" },
      { change: "removed", text: "task" },
      { change: "added", text: "system prompt" },
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

  test("a Project's glossary shows its Terms over the Workspace's, replacing those of the same name", async () => {
    const { ada, workspace, project, asAgent } = await workspaceWithProject();
    const other = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Other", key: "OTHER" });
    const workspaceTerms = `/api/workspaces/${workspace.id}/terms`;
    await ok("POST", workspaceTerms, ada, { name: "Ticket", definition: "A unit of work." });
    await ok("POST", workspaceTerms, ada, { name: "Run", definition: "One agent execution." });
    await ok("POST", workspaceTerms, ada, { name: "Agent", definition: "A non-human account." });
    await ok("POST", `/api/projects/${project.id}/terms`, ada, { name: "run", definition: "Here: one Claude session." });
    await ok("POST", `/api/projects/${project.id}/terms`, ada, { name: "Board", definition: "The Statuses as columns." });
    await ok("POST", `/api/projects/${other.id}/terms`, ada, { name: "Ticket", definition: "Elsewhere's Ticket." });

    const glossary = await ok("GET", `/api/projects/${project.id}/glossary`, asAgent);

    expect(glossary.map((t: { name: string; definition: string; projectId: string | null }) => [t.name, t.definition, t.projectId])).toEqual([
      ["Agent", "A non-human account.", null],
      ["Board", "The Statuses as columns.", project.id],
      ["run", "Here: one Claude session.", project.id],
      ["Ticket", "A unit of work.", null],
    ]);
  });
});


describe("deleting a Term", () => {
  test("a User deletes a Term with its Versions", async () => {
    const { ada, project } = await workspaceWithProject();
    const terms = `/api/projects/${project.id}/terms`;
    const term = await ok("POST", terms, ada, { name: "Draft" });
    await ok("POST", terms, ada, { name: "Run" });

    const deleted = await call("DELETE", `/api/terms/${term.id}`, ada);

    expect(deleted.status).toBe(204);
    expect((await call("GET", `/api/terms/${term.id}`, ada)).status).toBe(404);
    expect((await call("GET", `/api/terms/${term.id}/versions`, ada)).status).toBe(404);
    expect((await ok("GET", terms, ada)).map((t: { name: string }) => t.name)).toEqual(["Run"]);
    expect((await call("POST", terms, ada, { name: "draft" })).status).toBe(201);
  });
});

describe("refusals", () => {
  test("refused, changing nothing: another Workspace's member or Agent, an Agent's delete, a read-only token's writes, and a Version the Term doesn't have", async () => {
    const { ada, workspace, project, agent, asAgent } = await workspaceWithProject();
    // An Agent creates and edits Terms.
    const term = await ok("POST", `/api/projects/${project.id}/terms`, asAgent, { name: "Brief" });
    const workspaceTerm = await ok("POST", `/api/workspaces/${workspace.id}/terms`, asAgent, { name: "Run" });
    await ok("PATCH", `/api/terms/${workspaceTerm.id}`, asAgent, { baseVersion: 1, definition: "One agent execution." });
    const second = await ok("POST", "/api/workspaces", ada, { name: "Bob's Workspace" });
    const bob = await addMember(cronk, ada.cookie, second.id, "bob@example.com");
    const theirs = await ok("POST", `/api/workspaces/${second.id}/terms`, bob, { name: "Brief" });
    const bobsAgent = await ok("POST", `/api/workspaces/${second.id}/agents`, bob, { name: "bob-bot" });
    const { secret: bobsSecret } = await ok("POST", `/api/agents/${bobsAgent.id}/tokens`, bob, { name: "laptop", access: "full" });
    const asBobsAgent = { headers: { authorization: `Bearer ${bobsSecret}` } };
    const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "reader", access: "read" });
    const reader = { headers: { authorization: `Bearer ${secret}` } };
    // A read-only token reads Terms.
    expect((await ok("GET", `/api/terms/${term.id}`, reader)).name).toBe("Brief");
    expect((await ok("GET", `/api/projects/${project.id}/glossary`, reader)).length).toBe(2);

    const noVersion2 = expect.objectContaining({ code: "not_found", message: "The Term Brief has no Version 2." });
    const refusals: [string, As, string, string, unknown, number, unknown?][] = [];
    // Nothing crosses Workspaces: another Workspace's Terms answer as not found.
    for (const [who, as] of [["Bob", { cookie: bob.cookie }], ["Bob's Agent", asBobsAgent]] as const) {
      for (const [method, path, body] of [
        ["GET", `/api/terms/${term.id}`],
        ["GET", `/api/terms/${term.id}/versions`],
        ["GET", `/api/terms/${term.id}/versions/1`],
        ["GET", `/api/terms/${term.id}/versions/compare?from=1&to=1`],
        ["PATCH", `/api/terms/${term.id}`, { baseVersion: 1, definition: "Mine now." }],
        ["DELETE", `/api/terms/${term.id}`],
        ["GET", `/api/projects/${project.id}/terms`],
        ["POST", `/api/projects/${project.id}/terms`, { name: "Planted" }],
        ["GET", `/api/projects/${project.id}/glossary`],
        ["GET", `/api/workspaces/${workspace.id}/terms`],
        ["POST", `/api/workspaces/${workspace.id}/terms`, { name: "Planted" }],
      ] as const) {
        refusals.push([who, as, method, path, body, 404]);
      }
    }
    const agentDelete = expect.objectContaining({ code: "agent_not_allowed", rule: expect.stringContaining("Only a User deletes a Term") });
    refusals.push(
      ["an Agent", asAgent, "DELETE", `/api/terms/${term.id}`, undefined, 403, agentDelete],
      ["an Agent", asAgent, "DELETE", `/api/terms/${workspaceTerm.id}`, undefined, 403, agentDelete],
      ["a read-only token", reader, "POST", `/api/projects/${project.id}/terms`, { name: "Mine" }, 403, expect.objectContaining({ code: "read_only_token" })],
      ["a read-only token", reader, "PATCH", `/api/terms/${term.id}`, { baseVersion: 1, definition: "Mine." }, 403, expect.objectContaining({ code: "read_only_token" })],
      ["Ada", ada, "GET", `/api/terms/${term.id}/versions/2`, undefined, 404, noVersion2],
      ["Ada", ada, "GET", `/api/terms/${term.id}/versions/compare?from=1&to=2`, undefined, 404, noVersion2],
      ["Ada", ada, "GET", `/api/terms/${term.id}/versions/0`, undefined, 400],
    );
    for (const [who, as, method, path, body, status, error] of refusals) {
      const refused = await call(method, path, as, body);
      expect(refused.status, `${who}: ${method} ${path}`).toBe(status);
      if (error) expect(refused.json.error, `${who}: ${method} ${path}`).toEqual(error);
    }

    const versions = async (id: string) => (await ok("GET", `/api/terms/${id}/versions`, ada)).map((v: { number: number }) => v.number);
    expect(await versions(term.id)).toEqual([1]);
    expect(await versions(workspaceTerm.id)).toEqual([1, 2]);
    const ids = (terms: { id: string }[]) => terms.map((t) => t.id);
    expect(ids(await ok("GET", `/api/projects/${project.id}/terms`, ada))).toEqual([term.id]);
    expect(ids(await ok("GET", `/api/workspaces/${workspace.id}/terms`, ada))).toEqual([workspaceTerm.id]);
    expect(ids(await ok("GET", `/api/workspaces/${second.id}/terms`, bob))).toEqual([theirs.id]);
  });
});
