import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addMember, createGitHubApp, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";
import { openStream } from "../harness/stream.js";

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

/** The App's installations as the Add Repository picker gets them: account, then each Repository's `owner/name`. */
async function installationsListed(cookie: string) {
  const response = await cronk.request("GET", "/api/github/installations", { cookie });
  expect(response.status, await response.clone().text()).toBe(200);
  const installations: { account: string; repositories: { fullName: string }[] }[] = await response.json();
  return installations.map((i) => [i.account, i.repositories.map((r) => r.fullName)]);
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
    const added = await cronk.request("POST", `/api/projects/${project.id}/repositories`, { cookie, body: { id: 424242 } });

    expect(added.status).toBe(409);
    expect((await added.json()).error.code).toBe("repository_not_installed");
    expect(await repositoriesOf(project.id, cookie)).toEqual([]);
  });

  test("adding a Repository asks GitHub, so one the App no longer covers is refused though the kept list still has it", async () => {
    const { cookie, project, installation, website } = await projectWithApp();
    expect(await installationsListed(cookie)).toEqual([["cronkcorp", ["cronkcorp/cronker", "cronkcorp/website"]]]);

    // Removed from the installation on GitHub since.
    installation.repositories.splice(installation.repositories.indexOf(website), 1);
    const added = await cronk.request("POST", `/api/projects/${project.id}/repositories`, { cookie, body: { id: website.id } });

    expect(added.status).toBe(409);
    expect((await added.json()).error.code).toBe("repository_not_installed");
    expect(await repositoriesOf(project.id, cookie)).toEqual([]);
  });

  test("a Repository just installed on GitHub is added though the kept list doesn't have it yet", async () => {
    const { cookie, project, installation } = await projectWithApp();
    await installationsListed(cookie);

    installation.repositories.push({ id: 990001, name: "docs", fullName: "cronkcorp/docs" });
    const added = await cronk.request("POST", `/api/projects/${project.id}/repositories`, { cookie, body: { id: 990001 } });

    expect(added.status).toBe(201);
    expect(await repositoriesOf(project.id, cookie)).toEqual([{ id: 990001, fullName: "cronkcorp/docs", keyClash: false }]);
  });

  test("adding or removing a Repository has the App's installations asked of GitHub again", async () => {
    const { cookie, project, installation, cronker } = await projectWithApp();
    await installationsListed(cookie);

    installation.repositories.push({ id: 990001, name: "docs", fullName: "cronkcorp/docs" });
    await post(cookie, `/api/projects/${project.id}/repositories`, { id: cronker.id });
    expect(await installationsListed(cookie)).toEqual([["cronkcorp", ["cronkcorp/cronker", "cronkcorp/docs", "cronkcorp/website"]]]);

    installation.repositories.push({ id: 990002, name: "api", fullName: "cronkcorp/api" });
    await cronk.request("DELETE", `/api/projects/${project.id}/repositories/${cronker.id}`, { cookie });
    expect(await installationsListed(cookie)).toEqual([
      ["cronkcorp", ["cronkcorp/api", "cronkcorp/cronker", "cronkcorp/docs", "cronkcorp/website"]],
    ]);
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

  test("the other Project's Workspace hears its Project changed as the clash comes and goes, and nothing about whose it is", async () => {
    const { workspace, cookie, project, cronker } = await projectWithApp();
    await post(cookie, `/api/projects/${project.id}/repositories`, { id: cronker.id });
    const bea = await beasProject(cookie, "CRONK");
    const stream = await openStream(cronk, cookie, workspace.id);

    await post(bea.cookie, `/api/projects/${bea.project.id}/repositories`, { id: cronker.id });
    expect(await stream.next()).toEqual({ type: "project.changed", data: { projectId: project.id } });

    await cronk.request("DELETE", `/api/projects/${bea.project.id}/repositories/${cronker.id}`, { cookie: bea.cookie });
    expect(await stream.next()).toEqual({ type: "project.changed", data: { projectId: project.id } });
    stream.close();
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
    const { cookie, app, installation, project, cronker } = await projectWithApp();
    await post(cookie, `/api/projects/${project.id}/repositories`, { id: cronker.id });

    cronker.name = "cronk";
    cronker.fullName = "cronkcorp/cronk";
    const delivered = await cronk.github.deliver(app, "repository", {
      action: "renamed",
      installation: { id: installation.id },
      changes: { repository: { name: { from: "cronker" } } },
      repository: { id: cronker.id, name: "cronk", full_name: "cronkcorp/cronk", owner: { login: "cronkcorp" } },
    });

    expect(delivered.status).toBe(200);
    expect(await repositoriesOf(project.id, cookie)).toEqual([{ id: cronker.id, fullName: "cronkcorp/cronk", keyClash: false }]);
  });

  test("a rename delivered late, after a newer one, leaves the newer name", async () => {
    const { cookie, app, installation, project, cronker } = await projectWithApp();
    await post(cookie, `/api/projects/${project.id}/repositories`, { id: cronker.id });
    const renamed = (name: string) => ({
      action: "renamed",
      installation: { id: installation.id },
      repository: { id: cronker.id, name, full_name: `cronkcorp/${name}`, owner: { login: "cronkcorp" } },
    });

    // Renamed twice on GitHub, cronker to cronker-two to cronk; the first rename's delivery arrives last.
    cronker.name = "cronk";
    cronker.fullName = "cronkcorp/cronk";
    await cronk.github.deliver(app, "repository", renamed("cronk"));
    await cronk.github.deliver(app, "repository", renamed("cronker-two"));

    expect(await repositoriesOf(project.id, cookie)).toEqual([{ id: cronker.id, fullName: "cronkcorp/cronk", keyClash: false }]);
  });

  test("a transfer to another owner updates the name the Project shows", async () => {
    const { cookie, app, installation, project, cronker } = await projectWithApp();
    await post(cookie, `/api/projects/${project.id}/repositories`, { id: cronker.id });

    // Transferred to an account the App isn't installed on, so GitHub no longer shows it to Cronk.
    installation.repositories.splice(installation.repositories.indexOf(cronker), 1);
    await cronk.github.deliver(app, "repository", {
      action: "transferred",
      installation: { id: installation.id },
      changes: { owner: { from: { user: { login: "cronkcorp" } } } },
      repository: { id: cronker.id, name: "cronker", full_name: "ada-gh/cronker", owner: { login: "ada-gh" } },
    });

    expect(await repositoriesOf(project.id, cookie)).toEqual([{ id: cronker.id, fullName: "ada-gh/cronker", keyClash: false }]);
  });

  test("a rename shows in the App's installations at once, for a Repository no Project lists too", async () => {
    const { cookie, app, installation, cronker } = await projectWithApp();
    expect(await installationsListed(cookie)).toEqual([["cronkcorp", ["cronkcorp/cronker", "cronkcorp/website"]]]);

    cronker.name = "zeta";
    cronker.fullName = "cronkcorp/zeta";
    await cronk.github.deliver(app, "repository", {
      action: "renamed",
      installation: { id: installation.id },
      repository: { id: cronker.id, name: "zeta", full_name: "cronkcorp/zeta", owner: { login: "cronkcorp" } },
    });

    expect(await installationsListed(cookie)).toEqual([["cronkcorp", ["cronkcorp/website", "cronkcorp/zeta"]]]);
  });

  test("a transfer to another account the App is installed on shows in the App's installations at once", async () => {
    const { cookie, app, installation, cronker } = await projectWithApp();
    const bea = cronk.github.install(app, "bea", ["notes"]);
    expect(await installationsListed(cookie)).toEqual([
      ["bea", ["bea/notes"]],
      ["cronkcorp", ["cronkcorp/cronker", "cronkcorp/website"]],
    ]);

    installation.repositories.splice(installation.repositories.indexOf(cronker), 1);
    cronker.fullName = "bea/cronker";
    bea.repositories.push(cronker);
    await cronk.github.deliver(app, "repository", {
      action: "transferred",
      installation: { id: bea.id },
      changes: { owner: { from: { user: { login: "cronkcorp" } } } },
      repository: { id: cronker.id, name: "cronker", full_name: "bea/cronker", owner: { login: "bea" } },
    });

    expect(await installationsListed(cookie)).toEqual([
      ["bea", ["bea/cronker", "bea/notes"]],
      ["cronkcorp", ["cronkcorp/website"]],
    ]);
  });
});
