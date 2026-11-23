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

const defaultBoard = [
  { name: "Backlog", kind: "backlog" },
  { name: "Triage", kind: "active" },
  { name: "Ready", kind: "backlog" },
  { name: "Investigate", kind: "active" },
  { name: "Implement", kind: "active" },
  { name: "Code review", kind: "active" },
  { name: "Merge", kind: "active" },
  { name: "In Review", kind: "review" },
  { name: "Done", kind: "done" },
  { name: "Canceled", kind: "canceled" },
];

/** The default board's Steps, by the Status they're on, and the model each wants. */
const stepModels: Record<string, string> = {
  Triage: "haiku",
  Investigate: "sonnet",
  Implement: "opus",
  "Code review": "sonnet",
  Merge: "haiku",
};

describe("creating a Project", () => {
  test("a new Project has a name, a key and the default board's Statuses with their kinds", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);

    const response = await cronk.request("POST", `/api/workspaces/${workspace.id}/projects`, {
      cookie,
      body: { name: "Cronker", key: "CRONK" },
    });

    expect(response.status).toBe(201);
    const project = await response.json();
    expect(project).toEqual({
      id: expect.any(String),
      workspaceId: workspace.id,
      name: "Cronker",
      key: "CRONK",
      visibility: "open",
      access: "write",
      archivedAt: null,
      archivedBy: null,
      newTicketsDelegated: false,
      autonomousDelegationDefault: false,
      pullRequestAutomation: true,
      agentsMayMerge: false,
      conciseReports: false,
      statuses: defaultBoard.map((status) => ({
        id: expect.any(String),
        ...status,
        step: stepModels[status.name] ? expect.objectContaining({ model: stepModels[status.name] }) : null,
      })),
    });

    const shown = await cronk.request("GET", `/api/projects/${project.id}`, { cookie });
    expect(shown.status).toBe(200);
    expect(await shown.json()).toEqual(project);

    const listed = await cronk.request("GET", `/api/workspaces/${workspace.id}/projects`, { cookie });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual([{ id: project.id, workspaceId: workspace.id, name: "Cronker", key: "CRONK", visibility: "open", access: "write", archivedAt: null, archivedBy: null }]);
  });
});

describe("an Agent creating a Project", () => {
  async function tokenOf(workspaceId: string, cookie: string, name: string, access: "read" | "write" | "full" = "write") {
    const agent = await (await cronk.request("POST", `/api/workspaces/${workspaceId}/agents`, { cookie, body: { name } })).json();
    const token = await (
      await cronk.request("POST", `/api/agents/${agent.id}/tokens`, { cookie, body: { name: "laptop", access } })
    ).json();
    return { authorization: `Bearer ${token.secret}` };
  }

  test("an Agent whose Owner is an Admin creates one with the default board, as a User does", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    const headers = await tokenOf(workspace.id, cookie, "claude");

    const response = await cronk.request("POST", `/api/workspaces/${workspace.id}/projects`, {
      headers,
      body: { name: "Cronker", key: "cronk" },
    });

    expect(response.status).toBe(201);
    const project = await response.json();
    expect(project).toEqual(expect.objectContaining({ key: "CRONK", visibility: "open", access: "write" }));
    expect(project.statuses.map((s: { name: string }) => s.name)).toEqual(defaultBoard.map((s) => s.name));
    expect(await (await cronk.request("GET", `/api/projects/${project.id}`, { headers })).json()).toEqual(project);
  });

  test("an Agent whose Owner isn't an Admin, or with a read-only token, is refused, naming the rule", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    const grace = await addMember(cronk, cookie, workspace.id, "grace@example.com");
    const create = (headers: Record<string, string>) =>
      cronk.request("POST", `/api/workspaces/${workspace.id}/projects`, { headers, body: { name: "Mine", key: "MINE" } });

    const notAdmin = await create(await tokenOf(workspace.id, grace.cookie, "grace-claude"));
    expect(notAdmin.status).toBe(403);
    expect((await notAdmin.json()).error).toEqual({
      code: "agent_not_allowed",
      message: expect.stringContaining("isn't an Admin"),
      rule: expect.stringContaining("creates a Project only when its Owner is an Admin of the Workspace"),
      advice: expect.stringContaining("grace@example.com"),
    });
    const readOnly = await create(await tokenOf(workspace.id, cookie, "reader", "read"));
    expect(readOnly.status).toBe(403);
    expect((await readOnly.json()).error.code).toBe("read_only_token");

    // Grace herself, a User, may.
    expect((await cronk.request("POST", `/api/workspaces/${workspace.id}/projects`, {
      cookie: grace.cookie,
      body: { name: "Mine", key: "MINE" },
    })).status).toBe(201);
  });
});

describe("Project refusals", () => {
  test("a key or name already used by a Project in the Workspace is refused, ignoring case", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    const create = (body: { name: string; key: string }) =>
      cronk.request("POST", `/api/workspaces/${workspace.id}/projects`, { cookie, body });
    expect((await create({ name: "Cronker", key: "CRONK" })).status).toBe(201);

    const sameKey = await create({ name: "Another", key: "cronk" });
    expect(sameKey.status).toBe(409);
    expect(await sameKey.json()).toEqual({
      error: { code: "project_key_taken", message: "Another Project in this Workspace already has the key CRONK." },
    });

    const sameName = await create({ name: "cronker", key: "OTHER" });
    expect(sameName.status).toBe(409);
    expect(await sameName.json()).toEqual({
      error: { code: "project_name_taken", message: "Another Project in this Workspace is already called cronker." },
    });

    const listed = await cronk.request("GET", `/api/workspaces/${workspace.id}/projects`, { cookie });
    expect((await listed.json()).map((p: { key: string }) => p.key)).toEqual(["CRONK"]);
  });

  test("a key is 2 to 10 letters and digits starting with a letter, and is kept in capitals", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    const create = (key: string) =>
      cronk.request("POST", `/api/workspaces/${workspace.id}/projects`, { cookie, body: { name: `P ${key}`, key } });

    for (const key of ["", "C", "1CRONK", "CRON-K", "CRONK CORP", "ABCDEFGHIJK"]) {
      const response = await create(key);
      expect(response.status, key).toBe(400);
      expect((await response.json()).error.code).toBe("invalid_request");
    }

    const lower = await create("ops2");
    expect(lower.status).toBe(201);
    expect((await lower.json()).key).toBe("OPS2");
  });

  test("Projects of a Workspace the User doesn't belong to answer as if they didn't exist", async () => {
    await setUp(cronk);
    const cookie = await signIn(cronk);

    for (const id of ["00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
      expect((await cronk.request("GET", `/api/projects/${id}`, { cookie })).status).toBe(404);
      expect((await cronk.request("GET", `/api/workspaces/${id}/projects`, { cookie })).status).toBe(404);
      const created = await cronk.request("POST", `/api/workspaces/${id}/projects`, {
        cookie,
        body: { name: "Cronker", key: "CRONK" },
      });
      expect(created.status).toBe(404);
    }
  });

  test("without a sign-in, Projects answer 401", async () => {
    const { workspace } = await setUp(cronk);
    const response = await cronk.request("GET", `/api/workspaces/${workspace.id}/projects`);
    expect(response.status).toBe(401);
  });
});

async function newProject() {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const response = await cronk.request("POST", `/api/workspaces/${workspace.id}/projects`, {
    cookie,
    body: { name: "Cronker", key: "CRONK" },
  });
  const project = (await response.json()) as { id: string; statuses: { id: string; name: string; kind: string }[] };
  const statusId = (name: string) => project.statuses.find((s) => s.name === name)!.id;
  return { cookie, project, statusId };
}

const board = (project: { statuses: { name: string; kind: string }[] }) =>
  project.statuses.map((s) => `${s.name}:${s.kind}`);

describe("editing a Project's Statuses", () => {
  test("a Status added without a position goes last on the board", async () => {
    const { cookie, project } = await newProject();

    const response = await cronk.request("POST", `/api/projects/${project.id}/statuses`, {
      cookie,
      body: { name: "Blocked", kind: "active" },
    });

    expect(response.status).toBe(201);
    const changed = await response.json();
    expect(board(changed)).toEqual([
      "Backlog:backlog",
      "Triage:active",
      "Ready:backlog",
      "Investigate:active",
      "Implement:active",
      "Code review:active",
      "Merge:active",
      "In Review:review",
      "Done:done",
      "Canceled:canceled",
      "Blocked:active",
    ]);
    expect(await (await cronk.request("GET", `/api/projects/${project.id}`, { cookie })).json()).toEqual(changed);
  });

  test("a Status added at a position goes there, counting from 0", async () => {
    const { cookie, project } = await newProject();

    const response = await cronk.request("POST", `/api/projects/${project.id}/statuses`, {
      cookie,
      body: { name: "Icebox", kind: "backlog", position: 0 },
    });

    expect(response.status).toBe(201);
    expect(board(await response.json()).slice(0, 3)).toEqual(["Icebox:backlog", "Backlog:backlog", "Triage:active"]);
  });

  test("a Status is renamed", async () => {
    const { cookie, project, statusId } = await newProject();

    const response = await cronk.request("PATCH", `/api/projects/${project.id}/statuses/${statusId("Ready")}`, {
      cookie,
      body: { name: "Todo" },
    });

    expect(response.status).toBe(200);
    const changed = await response.json();
    expect(changed.statuses[2]).toEqual({ id: statusId("Ready"), name: "Todo", kind: "backlog", step: null });
    expect(await (await cronk.request("GET", `/api/projects/${project.id}`, { cookie })).json()).toEqual(changed);
  });

  test("a Status moved to a position goes there, and the others close up around it", async () => {
    const { cookie, project, statusId } = await newProject();
    const move = (name: string, position: number) =>
      cronk.request("PATCH", `/api/projects/${project.id}/statuses/${statusId(name)}`, { cookie, body: { position } });

    const later = await move("Triage", 3);
    expect(later.status).toBe(200);
    expect(board(await later.json()).slice(0, 5)).toEqual([
      "Backlog:backlog",
      "Ready:backlog",
      "Investigate:active",
      "Triage:active",
      "Implement:active",
    ]);

    const earlier = await move("Canceled", 0);
    expect(board(await earlier.json())).toEqual([
      "Canceled:canceled",
      "Backlog:backlog",
      "Ready:backlog",
      "Investigate:active",
      "Triage:active",
      "Implement:active",
      "Code review:active",
      "Merge:active",
      "In Review:review",
      "Done:done",
    ]);
  });

  test("a Status's kind is changed while another Status keeps the old kind", async () => {
    const { cookie, project, statusId } = await newProject();

    const response = await cronk.request("PATCH", `/api/projects/${project.id}/statuses/${statusId("Code review")}`, {
      cookie,
      body: { kind: "review" },
    });

    expect(response.status).toBe(200);
    expect((await response.json()).statuses[5]).toEqual({
      id: statusId("Code review"),
      name: "Code review",
      kind: "review",
      step: expect.objectContaining({ model: "sonnet" }),
    });
  });

  test("a Status is removed while another Status keeps its kind", async () => {
    const { cookie, project, statusId } = await newProject();

    const response = await cronk.request("DELETE", `/api/projects/${project.id}/statuses/${statusId("Investigate")}`, {
      cookie,
    });

    expect(response.status).toBe(200);
    const changed = await response.json();
    expect(changed.statuses.map((s: { name: string }) => s.name)).toEqual([
      "Backlog",
      "Triage",
      "Ready",
      "Implement",
      "Code review",
      "Merge",
      "In Review",
      "Done",
      "Canceled",
    ]);
    expect(await (await cronk.request("GET", `/api/projects/${project.id}`, { cookie })).json()).toEqual(changed);
  });
});

describe("every Status kind keeps a Status", () => {
  test("removing the only Status of a kind is refused with a clear message, and nothing changes", async () => {
    const { cookie, project, statusId } = await newProject();

    const response = await cronk.request("DELETE", `/api/projects/${project.id}/statuses/${statusId("Canceled")}`, {
      cookie,
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "status_kind_needed",
        message:
          "Every Project needs at least one Canceled Status, and Canceled is this Project's only one. Add another Canceled Status first.",
      },
    });
    expect(await (await cronk.request("GET", `/api/projects/${project.id}`, { cookie })).json()).toEqual(project);
  });

  test("changing the kind of the only Status of a kind is refused", async () => {
    const { cookie, project, statusId } = await newProject();

    const response = await cronk.request("PATCH", `/api/projects/${project.id}/statuses/${statusId("In Review")}`, {
      cookie,
      body: { kind: "active" },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "status_kind_needed",
        message:
          "Every Project needs at least one Review Status, and In Review is this Project's only one. Add another Review Status first.",
      },
    });
    expect(await (await cronk.request("GET", `/api/projects/${project.id}`, { cookie })).json()).toEqual(project);
  });

  test("once another Status has the kind, the last one's kind can change or it can go", async () => {
    const { cookie, project, statusId } = await newProject();
    await cronk.request("POST", `/api/projects/${project.id}/statuses`, {
      cookie,
      body: { name: "Won't do", kind: "canceled" },
    });

    const changed = await cronk.request("PATCH", `/api/projects/${project.id}/statuses/${statusId("Canceled")}`, {
      cookie,
      body: { kind: "done" },
    });
    expect(changed.status).toBe(200);
    expect(board(await changed.json()).slice(-2)).toEqual(["Canceled:done", "Won't do:canceled"]);

    const removed = await cronk.request("DELETE", `/api/projects/${project.id}/statuses/${statusId("Canceled")}`, {
      cookie,
    });
    expect(removed.status).toBe(200);
    expect(board(await removed.json()).slice(-2)).toEqual(["Done:done", "Won't do:canceled"]);
  });

  test("removing every Status of a kind one by one is refused at the last", async () => {
    const { cookie, project, statusId } = await newProject();
    const remove = (name: string) =>
      cronk.request("DELETE", `/api/projects/${project.id}/statuses/${statusId(name)}`, { cookie });

    // Outcomes of Triage's and Implement's Steps move Tickets to Ready.
    for (const name of ["Triage", "Implement"]) {
      await cronk.request("DELETE", `/api/projects/${project.id}/statuses/${statusId(name)}/step`, { cookie });
    }

    expect((await remove("Ready")).status).toBe(200);
    const last = await remove("Backlog");
    expect(last.status).toBe(409);
    expect((await last.json()).error.message).toBe(
      "Every Project needs at least one Backlog Status, and Backlog is this Project's only one. Add another Backlog Status first.",
    );
  });
});

describe("Status refusals", () => {
  test("a Status name already on the board is refused, ignoring case", async () => {
    const { cookie, project, statusId } = await newProject();

    const added = await cronk.request("POST", `/api/projects/${project.id}/statuses`, {
      cookie,
      body: { name: "done", kind: "done" },
    });
    expect(added.status).toBe(409);
    expect(await added.json()).toEqual({
      error: { code: "status_name_taken", message: "This Project already has a Status called done." },
    });

    const renamed = await cronk.request("PATCH", `/api/projects/${project.id}/statuses/${statusId("Ready")}`, {
      cookie,
      body: { name: "Backlog" },
    });
    expect(renamed.status).toBe(409);
    expect((await renamed.json()).error.code).toBe("status_name_taken");

    const recased = await cronk.request("PATCH", `/api/projects/${project.id}/statuses/${statusId("Ready")}`, {
      cookie,
      body: { name: "READY" },
    });
    expect(recased.status).toBe(200);
  });

  test("a position off the board is refused", async () => {
    const { cookie, project, statusId } = await newProject();

    const added = await cronk.request("POST", `/api/projects/${project.id}/statuses`, {
      cookie,
      body: { name: "Later", kind: "backlog", position: 11 },
    });
    expect(added.status).toBe(400);
    expect(await added.json()).toEqual({
      error: { code: "invalid_position", message: "A position on this board is from 0 to 10." },
    });

    const moved = await cronk.request("PATCH", `/api/projects/${project.id}/statuses/${statusId("Ready")}`, {
      cookie,
      body: { position: 10 },
    });
    expect(moved.status).toBe(400);
    expect((await moved.json()).error.message).toBe("A position on this board is from 0 to 9.");
  });

  test("an unknown Status kind is refused", async () => {
    const { cookie, project } = await newProject();

    const response = await cronk.request("POST", `/api/projects/${project.id}/statuses`, {
      cookie,
      body: { name: "Parked", kind: "paused" },
    });
    expect(response.status).toBe(400);
  });

  test("a Status that isn't on the Project's board answers 404", async () => {
    const { cookie, project } = await newProject();

    for (const id of ["00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
      const edited = await cronk.request("PATCH", `/api/projects/${project.id}/statuses/${id}`, {
        cookie,
        body: { name: "Gone" },
      });
      expect(edited.status).toBe(404);
      const removed = await cronk.request("DELETE", `/api/projects/${project.id}/statuses/${id}`, { cookie });
      expect(removed.status).toBe(404);
    }
  });

  test("Statuses of a Project the User can't see answer 404", async () => {
    const { cookie, project } = await newProject();
    const elsewhere = "00000000-0000-4000-8000-000000000000";

    const added = await cronk.request("POST", `/api/projects/${elsewhere}/statuses`, {
      cookie,
      body: { name: "Later", kind: "backlog" },
    });
    expect(added.status).toBe(404);
    const removed = await cronk.request("DELETE", `/api/projects/${elsewhere}/statuses/${project.statuses[0]!.id}`, {
      cookie,
    });
    expect(removed.status).toBe(404);
  });
});
