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

const defaultBoard = [
  { name: "Backlog", kind: "backlog" },
  { name: "Triage", kind: "active" },
  { name: "Ready", kind: "backlog" },
  { name: "Investigate", kind: "active" },
  { name: "Implement", kind: "active" },
  { name: "Code review", kind: "active" },
  { name: "In Review", kind: "review" },
  { name: "Done", kind: "done" },
  { name: "Canceled", kind: "canceled" },
];

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
      statuses: defaultBoard.map((status) => ({ id: expect.any(String), ...status })),
    });

    const shown = await cronk.request("GET", `/api/projects/${project.id}`, { cookie });
    expect(shown.status).toBe(200);
    expect(await shown.json()).toEqual(project);

    const listed = await cronk.request("GET", `/api/workspaces/${workspace.id}/projects`, { cookie });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual([{ id: project.id, workspaceId: workspace.id, name: "Cronker", key: "CRONK" }]);
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
