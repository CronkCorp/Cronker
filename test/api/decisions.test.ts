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

describe("Decisions", () => {
  test("a User records a Decision in a Project, proposed at its first Version, saved by them", async () => {
    const { ada, user, project, workspace } = await workspaceWithProject();

    const created = await call("POST", `/api/projects/${project.id}/decisions`, ada, {
      title: "Use Postgres",
      body: "## Context\n\nWe need a database.",
    });

    expect(created.status).toBe(201);
    const read = await ok("GET", `/api/decisions/${created.json.id}`, ada);
    expect(read).toEqual({
      id: created.json.id,
      workspaceId: workspace.id,
      projectId: project.id,
      number: 1,
      title: "Use Postgres",
      body: "## Context\n\nWe need a database.",
      status: "proposed",
      supersededById: null,
      version: {
        number: 1,
        title: "Use Postgres",
        status: "proposed",
        supersededById: null,
        actor: { kind: "user", id: user.id, name: "ada@example.com" },
        savedAt: "2026-01-01T09:00:00.000Z",
      },
      mentions: [],
      mentionedIn: [],
    });
  });

  test("Decisions are numbered in order of creation, separately for each Project and for the Workspace", async () => {
    const { ada, workspace, project, asAgent } = await workspaceWithProject();
    const other = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Website", key: "WEB" });

    const record = async (path: string, as: As, title: string) => (await ok("POST", path, as, { title })).number;
    const numbers = [
      await record(`/api/projects/${project.id}/decisions`, ada, "Use Postgres"),
      await record(`/api/workspaces/${workspace.id}/decisions`, ada, "Write in English"),
      await record(`/api/projects/${project.id}/decisions`, asAgent, "Use Fastify"),
      await record(`/api/projects/${other.id}/decisions`, ada, "Use Astro"),
      await record(`/api/workspaces/${workspace.id}/decisions`, asAgent, "Squash merges"),
      await record(`/api/projects/${project.id}/decisions`, ada, "Use TypeBox"),
    ];

    expect(numbers).toEqual([1, 1, 2, 1, 2, 3]);
    const listed = await ok("GET", `/api/projects/${project.id}/decisions`, ada);
    expect(listed.map((d: { number: number; title: string; status: string }) => [d.number, d.title, d.status])).toEqual([
      [1, "Use Postgres", "proposed"],
      [2, "Use Fastify", "proposed"],
      [3, "Use TypeBox", "proposed"],
    ]);
    const workspaceDecisions = await ok("GET", `/api/workspaces/${workspace.id}/decisions`, asAgent);
    expect(workspaceDecisions.map((d: { title: string; projectId: string | null }) => [d.title, d.projectId])).toEqual([
      ["Write in English", null],
      ["Squash merges", null],
    ]);
  });

  test("Decisions recorded at the same time each get their own number", async () => {
    const { ada, project } = await workspaceWithProject();

    const created = await Promise.all(
      Array.from({ length: 8 }, (_, i) => ok("POST", `/api/projects/${project.id}/decisions`, ada, { title: `Choice ${i}` })),
    );

    expect(created.map((d: { number: number }) => d.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("each save of a Decision's text makes the next Version, recording its Actor", async () => {
    const { ada, project, agent, asAgent } = await workspaceWithProject();
    const decision = await ok("POST", `/api/projects/${project.id}/decisions`, ada, { title: "Use Postgres", body: "One." });

    cronk.clock.advance(60_000);
    const saved = await ok("PATCH", `/api/decisions/${decision.id}`, asAgent, {
      baseVersion: 1,
      title: "Use Postgres 16",
      body: "One. Two.",
    });

    expect(saved).toEqual(
      expect.objectContaining({
        number: 1,
        title: "Use Postgres 16",
        body: "One. Two.",
        status: "proposed",
        version: {
          number: 2,
          title: "Use Postgres 16",
          status: "proposed",
          supersededById: null,
          actor: { kind: "agent", id: agent.id, name: "claude-max" },
          savedAt: "2026-01-01T09:01:00.000Z",
        },
      }),
    );
    expect((await ok("GET", `/api/decisions/${decision.id}`, ada)).body).toBe("One. Two.");
  });

  test("a save based on an outdated Version is refused with the current Version", async () => {
    const { ada, project, asAgent } = await workspaceWithProject();
    const decision = await ok("POST", `/api/projects/${project.id}/decisions`, ada, { title: "Use Postgres", body: "One." });
    await ok("PATCH", `/api/decisions/${decision.id}`, ada, { baseVersion: 1, body: "Ada's." });

    const refused = await call("PATCH", `/api/decisions/${decision.id}`, asAgent, { baseVersion: 1, body: "Mine." });
    const unnamed = await call("PATCH", `/api/decisions/${decision.id}`, ada, { body: "No base." });

    expect(refused.status).toBe(409);
    expect(refused.json.error).toEqual(
      expect.objectContaining({
        code: "outdated_version",
        rule: expect.any(String),
        advice: expect.any(String),
        current: expect.objectContaining({ number: 2, body: "Ada's." }),
      }),
    );
    expect(unnamed.status).toBe(400);
    expect(unnamed.json.error.code).toBe("base_version_needed");
    expect((await ok("GET", `/api/decisions/${decision.id}`, ada)).body).toBe("Ada's.");
  });

  test("a Decision's Versions are listed oldest first, each read, and two compared line by line", async () => {
    const { ada, project, asAgent } = await workspaceWithProject();
    const decision = await ok("POST", `/api/projects/${project.id}/decisions`, ada, { title: "Use Postgres", body: "Run it." });
    await ok("PATCH", `/api/decisions/${decision.id}`, asAgent, { baseVersion: 1, body: "Install it.\nRun it." });
    const path = `/api/decisions/${decision.id}/versions`;

    const versions = await ok("GET", path, ada);
    const first = await ok("GET", `${path}/1`, asAgent);
    const compared = await ok("GET", `${path}/compare?from=1&to=2`, ada);

    expect(versions.map((v: { number: number; actor: { name: string } }) => [v.number, v.actor.name])).toEqual([
      [1, "ada@example.com"],
      [2, "claude-max"],
    ]);
    expect(first).toEqual(expect.objectContaining({ number: 1, title: "Use Postgres", body: "Run it.", status: "proposed" }));
    expect(compared.lines).toEqual([
      { change: "added", text: "Install it." },
      { change: "same", text: "Run it." },
    ]);
    expect((await call("GET", `${path}/3`, ada)).status).toBe(404);
  });

  test("a User accepts a Decision as its next Version, and its text stays editable", async () => {
    const { ada, user, project, asAgent } = await workspaceWithProject();
    const decision = await ok("POST", `/api/projects/${project.id}/decisions`, asAgent, { title: "Use Postgres" });

    const accepted = await ok("PATCH", `/api/decisions/${decision.id}`, ada, { baseVersion: 1, status: "accepted" });
    const fixed = await ok("PATCH", `/api/decisions/${decision.id}`, asAgent, { baseVersion: 2, body: "Fixed a typo." });

    expect(accepted.status).toBe("accepted");
    expect(accepted.version).toEqual(
      expect.objectContaining({ number: 2, status: "accepted", actor: { kind: "user", id: user.id, name: "ada@example.com" } }),
    );
    expect(fixed).toEqual(expect.objectContaining({ status: "accepted", body: "Fixed a typo.", version: expect.objectContaining({ number: 3 }) }));
    const versions = await ok("GET", `/api/decisions/${decision.id}/versions`, ada);
    expect(versions.map((v: { status: string }) => v.status)).toEqual(["proposed", "accepted", "accepted"]);
  });

  test("a User records a Decision with a status, and moves it between them", async () => {
    const { ada, project } = await workspaceWithProject();

    const accepted = await ok("POST", `/api/projects/${project.id}/decisions`, ada, { title: "Use Postgres", status: "accepted" });
    const rejected = await ok("PATCH", `/api/decisions/${accepted.id}`, ada, { baseVersion: 1, status: "rejected" });
    const deprecated = await ok("PATCH", `/api/decisions/${accepted.id}`, ada, { baseVersion: 2, status: "deprecated" });
    const proposed = await ok("PATCH", `/api/decisions/${accepted.id}`, ada, { baseVersion: 3, status: "proposed" });

    expect([accepted.status, rejected.status, deprecated.status, proposed.status]).toEqual([
      "accepted",
      "rejected",
      "deprecated",
      "proposed",
    ]);
    const unknown = await call("PATCH", `/api/decisions/${accepted.id}`, ada, { baseVersion: 4, status: "decided" });
    expect(unknown.status).toBe(400);
  });

  test("a User marks a Decision superseded by naming the Decision that replaces it, in the same Project", async () => {
    const { ada, user, project } = await workspaceWithProject();
    const old = await ok("POST", `/api/projects/${project.id}/decisions`, ada, { title: "Use MySQL", status: "accepted" });
    const replacement = await ok("POST", `/api/projects/${project.id}/decisions`, ada, { title: "Use Postgres" });

    const superseded = await ok("PATCH", `/api/decisions/${old.id}`, ada, {
      baseVersion: 1,
      status: "superseded",
      supersededById: replacement.id,
    });
    const edited = await ok("PATCH", `/api/decisions/${old.id}`, ada, { baseVersion: 2, body: "We moved on." });

    expect(superseded).toEqual(
      expect.objectContaining({
        status: "superseded",
        supersededById: replacement.id,
        version: expect.objectContaining({
          number: 2,
          status: "superseded",
          supersededById: replacement.id,
          actor: { kind: "user", id: user.id, name: "ada@example.com" },
        }),
      }),
    );
    expect(edited).toEqual(expect.objectContaining({ status: "superseded", supersededById: replacement.id }));
    const reopened = await ok("PATCH", `/api/decisions/${old.id}`, ada, { baseVersion: 3, status: "accepted" });
    expect(reopened).toEqual(expect.objectContaining({ status: "accepted", supersededById: null }));
  });

  test("superseded needs a replacing Decision, and only superseded takes one", async () => {
    const { ada, project } = await workspaceWithProject();
    const old = await ok("POST", `/api/projects/${project.id}/decisions`, ada, { title: "Use MySQL" });
    const replacement = await ok("POST", `/api/projects/${project.id}/decisions`, ada, { title: "Use Postgres" });

    const unnamed = await call("PATCH", `/api/decisions/${old.id}`, ada, { baseVersion: 1, status: "superseded" });
    const recorded = await call("POST", `/api/projects/${project.id}/decisions`, ada, { title: "Use Redis", status: "superseded" });
    const notSuperseded = await call("PATCH", `/api/decisions/${old.id}`, ada, {
      baseVersion: 1,
      status: "accepted",
      supersededById: replacement.id,
    });
    const itself = await call("PATCH", `/api/decisions/${old.id}`, ada, {
      baseVersion: 1,
      status: "superseded",
      supersededById: old.id,
    });

    expect([unnamed.status, unnamed.json.error.code]).toEqual([400, "superseding_decision_needed"]);
    expect([recorded.status, recorded.json.error.code]).toEqual([400, "superseding_decision_needed"]);
    expect([notSuperseded.status, notSuperseded.json.error.code]).toEqual([400, "superseding_decision_unexpected"]);
    expect([itself.status, itself.json.error.code]).toEqual([409, "superseding_decision_itself"]);
    expect(await ok("GET", `/api/decisions/${old.id}`, ada)).toEqual(
      expect.objectContaining({ status: "proposed", supersededById: null, version: expect.objectContaining({ number: 1 }) }),
    );
  });

  test("the replacing Decision is in the same Project, or both are the Workspace's own", async () => {
    const { ada, workspace, project } = await workspaceWithProject();
    const website = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Website", key: "WEB" });
    const old = await ok("POST", `/api/projects/${project.id}/decisions`, ada, { title: "Use MySQL" });
    const elsewhere = await ok("POST", `/api/projects/${website.id}/decisions`, ada, { title: "Use Postgres" });
    const workspaceWide = await ok("POST", `/api/workspaces/${workspace.id}/decisions`, ada, { title: "Use SQLite" });
    const alsoWorkspaceWide = await ok("POST", `/api/workspaces/${workspace.id}/decisions`, ada, { title: "Use DuckDB" });
    const friends = await ok("POST", "/api/workspaces", ada, { name: "Friends" });
    const theirs = await ok("POST", `/api/workspaces/${friends.id}/decisions`, ada, { title: "Use Oracle" });

    for (const [decision, replacement] of [
      [old, elsewhere],
      [old, workspaceWide],
      [workspaceWide, old],
      [old, theirs],
      [old, { id: "00000000-0000-0000-0000-000000000000" }],
    ]) {
      const refused = await call("PATCH", `/api/decisions/${decision.id}`, ada, {
        baseVersion: 1,
        status: "superseded",
        supersededById: replacement.id,
      });
      expect([refused.status, refused.json.error.code], `${decision.title} by ${replacement.title}`).toEqual([
        409,
        "superseding_decision_outside_scope",
      ]);
    }
    const inWorkspace = await ok("PATCH", `/api/decisions/${workspaceWide.id}`, ada, {
      baseVersion: 1,
      status: "superseded",
      supersededById: alsoWorkspaceWide.id,
    });
    expect(inWorkspace.supersededById).toBe(alsoWorkspaceWide.id);
  });

  test("a save that changes nothing makes no Version", async () => {
    const { ada, project } = await workspaceWithProject();
    const decision = await ok("POST", `/api/projects/${project.id}/decisions`, ada, { title: "Use Postgres", body: "One." });

    const same = await ok("PATCH", `/api/decisions/${decision.id}`, ada, {
      baseVersion: 1,
      title: "Use Postgres",
      body: "One.",
      status: "proposed",
    });

    expect(same.version.number).toBe(1);
    expect((await ok("GET", `/api/decisions/${decision.id}/versions`, ada)).length).toBe(1);
  });
});

describe("refusals", () => {
  test("refused, changing nothing: an Agent changing a status, anyone deleting, another Workspace's Decisions, and a read-only token's writes", async () => {
    const { ada, workspace, project, agent, asAgent } = await workspaceWithProject();
    // An Agent only proposes Decisions.
    const decision = await ok("POST", `/api/projects/${project.id}/decisions`, asAgent, { title: "Use Postgres", status: "proposed" });
    const other = await ok("POST", `/api/projects/${project.id}/decisions`, ada, { title: "Use MySQL" });
    await ok("POST", `/api/workspaces/${workspace.id}/decisions`, ada, { title: "Write in English" });
    const friends = await ok("POST", "/api/workspaces", ada, { name: "Friends" });
    const party = await ok("POST", `/api/workspaces/${friends.id}/projects`, ada, { name: "Party", key: "PARTY" });
    const theirs = await ok("POST", `/api/projects/${party.id}/decisions`, ada, { title: "Bring snacks" });
    expect(await ok("GET", `/api/workspaces/${friends.id}/decisions`, ada)).toEqual([]);
    const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "reader", access: "read" });
    const reader = { headers: { authorization: `Bearer ${secret}` } };
    // A read-only token reads Decisions.
    expect((await call("GET", `/api/decisions/${decision.id}`, reader)).status).toBe(200);
    expect((await call("GET", `/api/projects/${project.id}/decisions`, reader)).status).toBe(200);

    const statusRule = {
      code: "agent_not_allowed",
      message: expect.any(String),
      rule: "Agents propose Decisions and edit their text; only a User changes a Decision's status.",
      advice: expect.stringContaining("ada@example.com"),
    };
    const notDeletable = {
      code: "decision_not_deletable",
      message: expect.any(String),
      rule: "Decisions are never deleted, so their history stays.",
      advice: expect.stringContaining("rejected, deprecated or superseded"),
    };
    const readOnly = expect.objectContaining({ code: "read_only_token" });
    const refusals: [string, As, string, string, unknown, number, unknown?][] = [
      ["an Agent", asAgent, "POST", `/api/projects/${project.id}/decisions`, { title: "Use Redis", status: "accepted" }, 403, statusRule],
      ["an Agent", asAgent, "PATCH", `/api/decisions/${decision.id}`, { baseVersion: 1, status: "accepted" }, 403, statusRule],
      ["an Agent", asAgent, "PATCH", `/api/decisions/${decision.id}`, { baseVersion: 1, body: "Sure.", status: "rejected" }, 403, statusRule],
      ["an Agent", asAgent, "PATCH", `/api/decisions/${other.id}`, { baseVersion: 1, status: "superseded", supersededById: decision.id }, 403, statusRule],
      // Nobody deletes a Decision, User or Agent.
      ["Ada", ada, "DELETE", `/api/decisions/${decision.id}`, undefined, 405, notDeletable],
      ["an Agent", asAgent, "DELETE", `/api/decisions/${decision.id}`, undefined, 405, notDeletable],
      ["a read-only token", reader, "POST", `/api/projects/${project.id}/decisions`, { title: "Mine" }, 403, readOnly],
      ["a read-only token", reader, "PATCH", `/api/decisions/${decision.id}`, { baseVersion: 1, body: "Mine." }, 403, readOnly],
    ];
    // Nothing crosses Workspaces: another Workspace's Decisions answer as not found.
    for (const [method, path, body] of [
      ["GET", `/api/decisions/${theirs.id}`],
      ["PATCH", `/api/decisions/${theirs.id}`, { baseVersion: 1, body: "Mine." }],
      ["GET", `/api/decisions/${theirs.id}/versions`],
      ["GET", `/api/decisions/${theirs.id}/versions/1`],
      ["GET", `/api/projects/${party.id}/decisions`],
      ["POST", `/api/projects/${party.id}/decisions`, { title: "Mine" }],
      ["GET", `/api/workspaces/${friends.id}/decisions`],
      ["POST", `/api/workspaces/${friends.id}/decisions`, { title: "Mine" }],
    ] as [string, string, unknown?][]) {
      refusals.push(["an Agent of another Workspace", asAgent, method, path, body, 404]);
    }
    for (const [who, as, method, path, body, status, error] of refusals) {
      const refused = await call(method, path, as, body);
      expect(refused.status, `${who}: ${method} ${path}`).toBe(status);
      if (error) expect(refused.json.error, `${who}: ${method} ${path}`).toEqual(error);
    }

    const unchanged = await ok("GET", `/api/decisions/${decision.id}`, ada);
    expect(unchanged).toEqual(expect.objectContaining({ status: "proposed", body: "", version: expect.objectContaining({ number: 1 }) }));
    expect((await ok("GET", `/api/projects/${project.id}/decisions`, ada)).map((d: { title: string }) => d.title)).toEqual([
      "Use Postgres",
      "Use MySQL",
    ]);
    expect((await ok("GET", `/api/projects/${party.id}/decisions`, ada)).map((d: { id: string }) => d.id)).toEqual([theirs.id]);
    const bea = await addMember(cronk, ada.cookie, friends.id, "bea@example.com");
    expect((await call("GET", `/api/decisions/${decision.id}`, { cookie: bea.cookie })).status).toBe(404);
    expect((await call("GET", `/api/decisions/${theirs.id}`, { cookie: bea.cookie })).status).toBe(200);
    // An Agent's save that keeps the status is no status change.
    const keptStatus = await call("PATCH", `/api/decisions/${decision.id}`, asAgent, { baseVersion: 1, status: "proposed", body: "Why." });
    expect(keptStatus.status).toBe(200);
  });
});
