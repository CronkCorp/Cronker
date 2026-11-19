import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addMember, createGitHubApp, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

let cronk: StartedCronk;
beforeEach(async () => {
  cronk = await startCronk();
});
afterEach(async () => {
  await cronk?.stop();
});

/** Ada's Workspace with the GitHub App installed on `cronkcorp`'s `cronker` and `website`, and a Project. */
async function projectWithApp() {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  await createGitHubApp(cronk, cookie);
  const app = cronk.github.apps[0]!;
  const installation = cronk.github.install(app, "cronkcorp", ["cronker", "website"]);
  const [cronker, website] = [installation.repositories[0]!, installation.repositories[1]!];
  const project = await post(cookie, `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  return { workspace, cookie, app, installation, project, cronker, website };
}

async function post(cookie: string, path: string, body: unknown) {
  const response = await cronk.request("POST", path, { cookie, body });
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json();
}

const repositoriesOf = async (projectId: string, cookie: string) =>
  (await cronk.request("GET", `/api/projects/${projectId}/repositories`, { cookie })).json();

describe("Repositories on a Project", () => {
  test("a User adds a Repository the App's installation covers, and the Project lists it by owner and name", async () => {
    const { cookie, project, cronker } = await projectWithApp();

    const added = await cronk.request("POST", `/api/projects/${project.id}/repositories`, { cookie, body: { id: cronker.id } });

    expect(added.status).toBe(201);
    expect(await added.json()).toEqual({ id: cronker.id, fullName: "cronkcorp/cronker", keyClash: false });
    expect(await repositoriesOf(project.id, cookie)).toEqual([{ id: cronker.id, fullName: "cronkcorp/cronker", keyClash: false }]);
  });

  test("a User removes a Repository from a Project, and the Project no longer lists it", async () => {
    const { cookie, project, cronker, website } = await projectWithApp();
    await post(cookie, `/api/projects/${project.id}/repositories`, { id: cronker.id });
    await post(cookie, `/api/projects/${project.id}/repositories`, { id: website.id });

    const removed = await cronk.request("DELETE", `/api/projects/${project.id}/repositories/${cronker.id}`, { cookie });

    expect(removed.status).toBe(204);
    expect(await repositoriesOf(project.id, cookie)).toEqual([{ id: website.id, fullName: "cronkcorp/website", keyClash: false }]);
    const again = await cronk.request("DELETE", `/api/projects/${project.id}/repositories/${cronker.id}`, { cookie });
    expect(again.status).toBe(404);
  });

  test("an Agent is refused adding or removing a Repository, though it reads the Project's list", async () => {
    const { workspace, cookie, project, cronker, website } = await projectWithApp();
    await post(cookie, `/api/projects/${project.id}/repositories`, { id: cronker.id });
    const agent = await post(cookie, `/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
    const { secret } = await post(cookie, `/api/agents/${agent.id}/tokens`, { name: "laptop", access: "full" });
    const headers = { authorization: `Bearer ${secret}` };

    const added = await cronk.request("POST", `/api/projects/${project.id}/repositories`, { headers, body: { id: website.id } });
    const removed = await cronk.request("DELETE", `/api/projects/${project.id}/repositories/${cronker.id}`, { headers });

    for (const refused of [added, removed]) {
      expect(refused.status).toBe(403);
      expect((await refused.json()).error.code).toBe("agent_not_allowed");
    }
    const listed = await cronk.request("GET", `/api/projects/${project.id}/repositories`, { headers });
    expect(await listed.json()).toEqual([{ id: cronker.id, fullName: "cronkcorp/cronker", keyClash: false }]);
  });

  test("a Repository no installation of the App covers is refused", async () => {
    const { cookie, project } = await projectWithApp();
    const elsewhere = cronk.github.install(cronk.github.apps[0]!, "someone", ["theirs"]).repositories[0]!;
    cronk.github.installations.pop();

    const added = await cronk.request("POST", `/api/projects/${project.id}/repositories`, { cookie, body: { id: elsewhere.id } });

    expect(added.status).toBe(409);
    expect((await added.json()).error.code).toBe("repository_not_installed");
    expect(await repositoriesOf(project.id, cookie)).toEqual([]);
  });

  test("a Repository the Project lists already is refused", async () => {
    const { cookie, project, cronker } = await projectWithApp();
    await post(cookie, `/api/projects/${project.id}/repositories`, { id: cronker.id });

    const again = await cronk.request("POST", `/api/projects/${project.id}/repositories`, { cookie, body: { id: cronker.id } });

    expect(again.status).toBe(409);
    expect((await again.json()).error.code).toBe("repository_already_listed");
  });
});

describe("Repositories across Workspaces", () => {
  test("a User of another Workspace neither sees nor changes a Project's Repositories", async () => {
    const { cookie, project, cronker, website } = await projectWithApp();
    await post(cookie, `/api/projects/${project.id}/repositories`, { id: cronker.id });
    const other = await post(cookie, "/api/workspaces", { name: "Bea's Workspace" });
    const bea = await addMember(cronk, cookie, other.id, "bea@example.com");

    const listed = await cronk.request("GET", `/api/projects/${project.id}/repositories`, { cookie: bea.cookie });
    const added = await cronk.request("POST", `/api/projects/${project.id}/repositories`, {
      cookie: bea.cookie,
      body: { id: website.id },
    });
    const removed = await cronk.request("DELETE", `/api/projects/${project.id}/repositories/${cronker.id}`, { cookie: bea.cookie });

    expect([listed.status, added.status, removed.status]).toEqual([404, 404, 404]);
    expect(await repositoriesOf(project.id, cookie)).toEqual([{ id: cronker.id, fullName: "cronkcorp/cronker", keyClash: false }]);
  });
});

describe("Projects sharing a key on one Repository", () => {
  /** Bea's own Workspace, made by Ada, with Bea as a member and a Project of hers. */
  async function beasProject(adaCookie: string, key: string) {
    const other = await post(adaCookie, "/api/workspaces", { name: "Bea's Workspace" });
    const bea = await addMember(cronk, adaCookie, other.id, "bea@example.com");
    const project = await post(bea.cookie, `/api/workspaces/${other.id}/projects`, { name: "Bea's secret project", key });
    return { cookie: bea.cookie, project };
  }

  test("a Project of another Workspace listing the Repository with the same key is warned about, without naming it", async () => {
    const { cookie, project, cronker } = await projectWithApp();
    await post(cookie, `/api/projects/${project.id}/repositories`, { id: cronker.id });
    const bea = await beasProject(cookie, "cronk");

    const added = await post(bea.cookie, `/api/projects/${bea.project.id}/repositories`, { id: cronker.id });

    const warned = { id: cronker.id, fullName: "cronkcorp/cronker", keyClash: true };
    expect(added).toEqual(warned);
    expect(await repositoriesOf(project.id, cookie)).toEqual([warned]);
    expect(await repositoriesOf(bea.project.id, bea.cookie)).toEqual([warned]);
  });

  test("the warning goes once the other Project no longer lists the Repository", async () => {
    const { cookie, project, cronker } = await projectWithApp();
    await post(cookie, `/api/projects/${project.id}/repositories`, { id: cronker.id });
    const bea = await beasProject(cookie, "CRONK");
    await post(bea.cookie, `/api/projects/${bea.project.id}/repositories`, { id: cronker.id });

    await cronk.request("DELETE", `/api/projects/${bea.project.id}/repositories/${cronker.id}`, { cookie: bea.cookie });

    expect(await repositoriesOf(project.id, cookie)).toEqual([{ id: cronker.id, fullName: "cronkcorp/cronker", keyClash: false }]);
  });

  test("Projects with different keys listing one Repository are not warned about", async () => {
    const { cookie, project, cronker } = await projectWithApp();
    await post(cookie, `/api/projects/${project.id}/repositories`, { id: cronker.id });
    const bea = await beasProject(cookie, "BEA");
    await post(bea.cookie, `/api/projects/${bea.project.id}/repositories`, { id: cronker.id });

    expect(await repositoriesOf(project.id, cookie)).toEqual([{ id: cronker.id, fullName: "cronkcorp/cronker", keyClash: false }]);
  });
});

describe("Repositories renamed or transferred on GitHub", () => {
  test("a rename updates the name the Project shows", async () => {
    const { cookie, app, project, cronker } = await projectWithApp();
    await post(cookie, `/api/projects/${project.id}/repositories`, { id: cronker.id });

    cronker.name = "cronk";
    cronker.fullName = "cronkcorp/cronk";
    const delivered = await cronk.github.deliver(app, "repository", {
      action: "renamed",
      changes: { repository: { name: { from: "cronker" } } },
      repository: { id: cronker.id, name: "cronk", full_name: "cronkcorp/cronk", owner: { login: "cronkcorp" } },
    });

    expect(delivered.status).toBe(200);
    expect(await repositoriesOf(project.id, cookie)).toEqual([{ id: cronker.id, fullName: "cronkcorp/cronk", keyClash: false }]);
  });

  test("a transfer to another owner updates the name the Project shows", async () => {
    const { cookie, app, project, cronker } = await projectWithApp();
    await post(cookie, `/api/projects/${project.id}/repositories`, { id: cronker.id });

    await cronk.github.deliver(app, "repository", {
      action: "transferred",
      changes: { owner: { from: { user: { login: "cronkcorp" } } } },
      repository: { id: cronker.id, name: "cronker", full_name: "ada-gh/cronker", owner: { login: "ada-gh" } },
    });

    expect(await repositoriesOf(project.id, cookie)).toEqual([{ id: cronker.id, fullName: "ada-gh/cronker", keyClash: false }]);
  });
});
