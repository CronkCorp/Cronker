import { afterEach, describe, expect, test } from "vitest";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

/**
 * Access (ADR 0010): what a Viewer may do in a Project, nothing, Read or Write, decided by one rule. These tests set a
 * Project's visibility, its listed Users and Agent Access in the database, and check what each Viewer then reads
 * through the HTTP API; `agent-access.test.ts` sets Agent Access through the API. `read-access.test.ts` lists Users with Read through the API and checks
 * their writes are refused.
 */

let cronk: StartedCronk;
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

async function tokenOf(as: As, workspaceId: string, name: string, access: "write" | "read") {
  const agent = await ok("POST", `/api/workspaces/${workspaceId}/agents`, as, { name });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, as, { name: "laptop", access });
  return { agent, as: { headers: { authorization: `Bearer ${secret}` } } };
}

/**
 * Ada, the Admin, with a Project CRONK holding a Ticket and a Document, Term and Decision, and Workspace knowledge;
 * Grace, a member who isn't an Admin; and an Agent of each, Grace's with a full and a read-only token.
 */
async function workspaceWithProject() {
  cronk = await startCronk();
  const { workspace } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const grace = await addMember(cronk, ada.cookie, workspace.id, "grace@example.com");
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "The Access seam" });
  const comment = await ok("POST", `/api/tickets/${ticket.id}/comments`, ada, { body: "Mind the Admins." });
  const document = await ok("POST", `/api/projects/${project.id}/documents`, ada, { title: "Plan", body: "One." });
  const term = await ok("POST", `/api/projects/${project.id}/terms`, ada, { name: "Access", definition: "Read or Write." });
  const decision = await ok("POST", `/api/projects/${project.id}/decisions`, ada, { title: "Seam first", body: "Why." });
  const handbook = await ok("POST", `/api/workspaces/${workspace.id}/documents`, ada, { title: "Handbook" });
  const adasAgent = await tokenOf(ada, workspace.id, "ada-claude", "write");
  const gracesAgent = await tokenOf({ cookie: grace.cookie }, workspace.id, "grace-claude", "write");
  const gracesReader = await tokenOf({ cookie: grace.cookie }, workspace.id, "grace-reader", "read");
  return {
    workspace,
    ada,
    grace: { ...grace, as: { cookie: grace.cookie } },
    project,
    ticket,
    comment,
    document,
    term,
    decision,
    handbook,
    adasAgent,
    gracesAgent,
    gracesReader,
  };
}

type Setting = Awaited<ReturnType<typeof workspaceWithProject>>;

/** Every read of the Project and what is in it, by id and by readable form. */
function projectReads({ project, ticket, document, term, decision }: Setting): string[] {
  return [
    `/api/projects/${project.id}`,
    `/api/projects/CRONK`,
    `/api/projects/${project.id}/tickets`,
    `/api/tickets/${ticket.id}`,
    `/api/tickets/CRONK-1`,
    `/api/tickets/${ticket.id}/comments`,
    `/api/tickets/${ticket.id}/relations`,
    `/api/documents/${document.id}`,
    `/api/documents/${document.id}/versions`,
    `/api/terms/${term.id}`,
    `/api/terms/CRONK%2FAccess`,
    `/api/decisions/${decision.id}`,
    `/api/decisions/CRONK%2F1`,
  ];
}

const projectKeys = async (setting: Setting, as: As) =>
  (await ok("GET", `/api/workspaces/${setting.workspace.id}/projects`, as)).map((p: { key: string }) => p.key);

const makePrivate = (projectId: string) => cronk.stage("update projects set visibility = 'private' where id = $1", [projectId]);

async function list(setting: Setting, userId: string, level: "read" | "write") {
  await cronk.stage(
    "insert into project_members (project_id, workspace_id, user_id, level, created_at) values ($1, $2, $3, $4, now())",
    [setting.project.id, setting.workspace.id, userId, level],
  );
}

async function expectReads(setting: Setting, as: As, status: 200 | 404) {
  for (const path of projectReads(setting)) expect((await call("GET", path, as)).status, path).toBe(status);
}

describe("with every Project open and Agent Access Write, as after upgrading", () => {
  test("Users and Agents read the Project and everything in it as an Admin does", async () => {
    const setting = await workspaceWithProject();
    const { ada, grace, adasAgent, gracesAgent, gracesReader } = setting;

    // A Project tells each caller its own Access: Write, but Read for a read-only token.
    const sameAs = (json: Record<string, unknown>) => ({ ...json, access: undefined });
    for (const path of projectReads(setting)) {
      const asAdmin = await ok("GET", path, ada);
      for (const as of [grace.as, adasAgent.as, gracesAgent.as, gracesReader.as]) {
        expect(sameAs(await ok("GET", path, as)), path).toEqual(sameAs(asAdmin));
      }
    }
    for (const as of [ada, grace.as, adasAgent.as, gracesAgent.as, gracesReader.as]) {
      expect(await projectKeys(setting, as)).toEqual(["CRONK"]);
      expect((await ok("GET", `/api/documents/${setting.handbook.id}`, as)).title).toBe("Handbook");
    }
  });

  test("Users and Agents still write as they did", async () => {
    const setting = await workspaceWithProject();
    const { grace, gracesAgent, ticket, document } = setting;

    await ok("POST", `/api/tickets/${ticket.id}/comments`, grace.as, { body: "From Grace." });
    await ok("POST", `/api/tickets/${ticket.id}/comments`, gracesAgent.as, { body: "From Grace's Agent." });
    await ok("PATCH", `/api/documents/${document.id}`, grace.as, { baseVersion: 1, body: "Two." });
    await ok("PATCH", `/api/documents/${document.id}`, gracesAgent.as, { baseVersion: 2, body: "Three." });
  });

  test("a record of another Workspace stays out of view", async () => {
    const setting = await workspaceWithProject();
    const friends = await ok("POST", "/api/workspaces", setting.ada, { name: "Friends" });
    const party = await ok("POST", `/api/workspaces/${friends.id}/projects`, setting.ada, { name: "Party", key: "PARTY" });

    expect((await call("GET", `/api/projects/${party.id}`, setting.grace.as)).status).toBe(404);
    expect((await call("GET", `/api/projects/${party.id}`, setting.adasAgent.as)).status).toBe(404);
  });
});

describe("a private Project", () => {
  test("answers as not found to a User it doesn't list, and to their Agents", async () => {
    const setting = await workspaceWithProject();
    await makePrivate(setting.project.id);

    for (const as of [setting.grace.as, setting.gracesAgent.as, setting.gracesReader.as]) {
      await expectReads(setting, as, 404);
      expect(await projectKeys(setting, as)).toEqual([]);
      expect((await ok("GET", `/api/documents/${setting.handbook.id}`, as)).title).toBe("Handbook");
    }
  });

  test("stays in reach of Admins and their Agents, whatever its list", async () => {
    const setting = await workspaceWithProject();
    await makePrivate(setting.project.id);

    for (const as of [setting.ada, setting.adasAgent.as]) {
      await expectReads(setting, as, 200);
      expect(await projectKeys(setting, as)).toEqual(["CRONK"]);
    }
  });

  test.each(["read", "write"] as const)("is read by a User it lists with %s, and by their Agents", async (level) => {
    const setting = await workspaceWithProject();
    await makePrivate(setting.project.id);
    await list(setting, setting.grace.user.id, level);

    for (const as of [setting.grace.as, setting.gracesAgent.as, setting.gracesReader.as]) {
      await expectReads(setting, as, 200);
      expect(await projectKeys(setting, as)).toEqual(["CRONK"]);
    }
  });
});

describe("an open Project's Agent Access", () => {
  test("None puts the Project out of every Agent's reach, but not their Owners'", async () => {
    const setting = await workspaceWithProject();
    await cronk.stage("update projects set agent_access = 'none' where id = $1", [setting.project.id]);

    for (const as of [setting.adasAgent.as, setting.gracesAgent.as, setting.gracesReader.as]) {
      await expectReads(setting, as, 404);
      expect(await projectKeys(setting, as)).toEqual([]);
    }
    for (const as of [setting.ada, setting.grace.as]) await expectReads(setting, as, 200);
  });

  test("Read lets Agents read it", async () => {
    const setting = await workspaceWithProject();
    await cronk.stage("update projects set agent_access = 'read' where id = $1", [setting.project.id]);

    for (const as of [setting.adasAgent.as, setting.gracesAgent.as, setting.gracesReader.as]) await expectReads(setting, as, 200);
  });

  test("an Agent never reads more than its Owner, whatever its Agent Access", async () => {
    const setting = await workspaceWithProject();
    await makePrivate(setting.project.id);

    expect((await call("GET", `/api/projects/${setting.project.id}`, setting.gracesAgent.as)).status).toBe(404);
    expect((await call("GET", `/api/projects/${setting.project.id}`, setting.adasAgent.as)).status).toBe(200);
  });
});

describe("the Workspace's Agent Access", () => {
  test("None puts the Workspace's own knowledge out of Agents' reach, and leaves Projects as they were", async () => {
    const setting = await workspaceWithProject();
    await cronk.stage("update workspaces set agent_access = 'none' where id = $1", [setting.workspace.id]);

    for (const as of [setting.adasAgent.as, setting.gracesAgent.as]) {
      expect((await call("GET", `/api/documents/${setting.handbook.id}`, as)).status).toBe(404);
      await expectReads(setting, as, 200);
    }
    for (const as of [setting.ada, setting.grace.as]) {
      expect((await call("GET", `/api/documents/${setting.handbook.id}`, as)).status).toBe(200);
    }
  });
});

describe("the list of a Project's Users", () => {
  test("takes only members of the Project's Workspace, and drops one who leaves it", async () => {
    const setting = await workspaceWithProject();
    await makePrivate(setting.project.id);
    await list(setting, setting.grace.user.id, "read");
    const friends = await ok("POST", "/api/workspaces", setting.ada, { name: "Friends" });
    const outsider = await addMember(cronk, setting.ada.cookie, friends.id, "linus@example.com");

    await expect(list(setting, outsider.user.id, "write")).rejects.toThrow(/foreign key/);
    // Removing Grace from the Workspace would fail on her listing if leaving didn't take her off the list.
    await ok("DELETE", `/api/workspaces/${setting.workspace.id}/members/${setting.grace.user.id}`, setting.ada);
  });
});
