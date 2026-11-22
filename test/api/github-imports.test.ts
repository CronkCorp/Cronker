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

/** Ada, an Admin, with the GitHub App installed on `cronkcorp`'s `cronker`, which her Project lists. */
async function projectListingRepository() {
  const { workspace, user } = await setUp(cronk);
  const cookie = await signIn(cronk);
  await createGitHubApp(cronk, cookie);
  const app = cronk.github.apps[0]!;
  const installation = cronk.github.install(app, "cronkcorp", ["cronker"]);
  const repository = installation.repositories[0]!;
  const project = await post(cookie, `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  await post(cookie, `/api/projects/${project.id}/repositories`, { id: repository.id });
  return { workspace, user, cookie, installation, repository, project };
}

async function post(cookie: string, path: string, body: unknown) {
  const response = await cronk.request("POST", path, { cookie, body });
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json();
}

const importPath = (projectId: string, repositoryId: number) => `/api/projects/${projectId}/repositories/${repositoryId}/import`;

async function startImport(cookie: string, projectId: string, repositoryId: number) {
  const response = await cronk.request("POST", importPath(projectId, repositoryId), { cookie });
  expect(response.status, await response.clone().text()).toBe(202);
  return response.json();
}

async function latestImport(cookie: string, projectId: string, repositoryId: number) {
  const response = await cronk.request("GET", importPath(projectId, repositoryId), { cookie });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()).import;
}

/** Runs the import check until no import is running, as the server does every five seconds. */
async function runImportsToEnd(cookie: string, projectId: string, repositoryId: number) {
  for (let pass = 0; pass < 20; pass++) {
    await cronk.runImports();
    const latest = await latestImport(cookie, projectId, repositoryId);
    if (latest.state !== "running") return latest;
  }
  throw new Error("the import never ended");
}

async function ticketsOf(cookie: string, projectId: string) {
  const response = await cronk.request("GET", `/api/projects/${projectId}/tickets`, { cookie });
  expect(response.status).toBe(200);
  return response.json();
}

async function timelineOf(cookie: string, ticketId: string) {
  const response = await cronk.request("GET", `/api/tickets/${ticketId}/timeline`, { cookie });
  expect(response.status).toBe(200);
  return response.json();
}

describe("importing a Repository's GitHub issues", () => {
  test("each issue becomes a Ticket in the Status its state maps to, with its title, body, Labels, time and link", async () => {
    const { cookie, user, repository, project } = await projectListingRepository();
    const created = new Date("2024-03-01T10:00:00Z");
    cronk.github.issue(repository, {
      title: "Open bug",
      body: "It breaks.",
      labels: ["bug", "Bug", "ui"],
      createdAt: created,
    });
    cronk.github.issue(repository, { title: "Shipped", state: "closed", stateReason: "completed", createdAt: new Date("2024-03-02T10:00:00Z") });
    cronk.github.issue(repository, { title: "Won't do", state: "closed", stateReason: "not_planned", createdAt: new Date("2024-03-03T10:00:00Z") });

    const started = await startImport(cookie, project.id, repository.id);
    expect(started).toMatchObject({ state: "running", imported: 0, skipped: 0, repository: { id: repository.id, fullName: "cronkcorp/cronker" } });
    const ended = await runImportsToEnd(cookie, project.id, repository.id);

    expect(ended).toMatchObject({ state: "done", imported: 3, skipped: 0, error: null, startedBy: user.id });
    expect(ended.finishedAt).not.toBeNull();
    const statusOf = (kind: string) => project.statuses.find((s: { kind: string }) => s.kind === kind).id;
    const tickets = await ticketsOf(cookie, project.id);
    const byTitle = Object.fromEntries(tickets.map((t: { title: string }) => [t.title, t]));
    expect(byTitle["Open bug"]).toMatchObject({
      key: "CRONK-1",
      description: "It breaks.",
      statusId: statusOf("backlog"),
      labels: ["bug", "ui"],
      verification: null,
      createdBy: user.id,
      createdAt: created.toISOString(),
    });
    expect(byTitle["Shipped"]).toMatchObject({ key: "CRONK-2", description: "", statusId: statusOf("done"), verification: "verified" });
    expect(byTitle["Won't do"]).toMatchObject({ key: "CRONK-3", statusId: statusOf("canceled"), verification: null });

    const timeline = await timelineOf(cookie, byTitle["Open bug"].id);
    expect(timeline).toEqual([
      expect.objectContaining({
        field: "created",
        actor: expect.objectContaining({ kind: "user", id: user.id }),
        at: created.toISOString(),
        from: null,
        to: { source: "github", url: `${cronk.github.url}/cronkcorp/cronker/issues/1` },
      }),
    ]);
  });

  test("nothing imported is delegated or assigned, even in a Project whose new Tickets start delegated", async () => {
    const { workspace, cookie, repository, project } = await projectListingRepository();
    await post(cookie, `/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
    const edited = await cronk.request("PATCH", `/api/projects/${project.id}`, { cookie, body: { newTicketsDelegated: true } });
    expect(edited.status, await edited.clone().text()).toBe(200);
    cronk.github.issue(repository, { title: "Open bug" });

    await startImport(cookie, project.id, repository.id);
    await runImportsToEnd(cookie, project.id, repository.id);

    const [ticket] = await ticketsOf(cookie, project.id);
    expect(ticket).toMatchObject({ title: "Open bug", delegateId: null, assigneeId: null, autonomousDelegation: null, lastRun: null });
  });

  test("Pull Requests among the issues are left out", async () => {
    const { cookie, repository, project } = await projectListingRepository();
    cronk.github.issue(repository, { title: "An issue" });
    cronk.github.issue(repository, { title: "A Pull Request", pullRequest: true });

    await startImport(cookie, project.id, repository.id);
    const ended = await runImportsToEnd(cookie, project.id, repository.id);

    expect(ended).toMatchObject({ imported: 1, skipped: 0 });
    expect((await ticketsOf(cookie, project.id)).map((t: { title: string }) => t.title)).toEqual(["An issue"]);
  });

  test("an import reads every page, oldest issue first, and shows its progress meanwhile", async () => {
    const { cookie, repository, project } = await projectListingRepository();
    for (let n = 1; n <= 150; n++) cronk.github.issue(repository, { title: `Issue ${n}`, createdAt: new Date(Date.UTC(2024, 0, 1, 0, n)) });

    await startImport(cookie, project.id, repository.id);
    await cronk.runImports();
    expect(await latestImport(cookie, project.id, repository.id)).toMatchObject({ state: "running", imported: 100 });
    await cronk.runImports();

    expect(await latestImport(cookie, project.id, repository.id)).toMatchObject({ state: "done", imported: 150, skipped: 0 });
    const tickets = await ticketsOf(cookie, project.id);
    expect(tickets).toHaveLength(150);
    const first = tickets.find((t: { key: string }) => t.key === "CRONK-1");
    const last = tickets.find((t: { key: string }) => t.key === "CRONK-150");
    expect([first.title, last.title]).toEqual(["Issue 1", "Issue 150"]);
  });

  test("importing again skips the issues imported before and brings only the new ones", async () => {
    const { cookie, repository, project } = await projectListingRepository();
    cronk.github.issue(repository, { title: "First" });
    await startImport(cookie, project.id, repository.id);
    await runImportsToEnd(cookie, project.id, repository.id);

    cronk.github.issue(repository, { title: "Second" });
    await startImport(cookie, project.id, repository.id);
    const ended = await runImportsToEnd(cookie, project.id, repository.id);

    expect(ended).toMatchObject({ state: "done", imported: 1, skipped: 1 });
    expect((await ticketsOf(cookie, project.id)).map((t: { title: string }) => t.title).sort()).toEqual(["First", "Second"]);
  });

  test("only one import runs in a Project at a time", async () => {
    const { cookie, repository, project } = await projectListingRepository();
    cronk.github.issue(repository, { title: "First" });
    await startImport(cookie, project.id, repository.id);

    const again = await cronk.request("POST", importPath(project.id, repository.id), { cookie });

    expect(again.status).toBe(409);
    expect((await again.json()).error.code).toBe("import_running");
    await runImportsToEnd(cookie, project.id, repository.id);
    expect((await cronk.request("POST", importPath(project.id, repository.id), { cookie })).status).toBe(202);
  });

  test("only an Admin of the Workspace starts an import; others are refused", async () => {
    const { workspace, cookie, repository, project } = await projectListingRepository();
    const member = await addMember(cronk, cookie, workspace.id, "grace@example.com");
    const agent = await post(cookie, `/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
    const { secret } = await post(cookie, `/api/agents/${agent.id}/tokens`, { name: "laptop", access: "full" });

    const byMember = await cronk.request("POST", importPath(project.id, repository.id), { cookie: member.cookie });
    const byAgent = await cronk.request("POST", importPath(project.id, repository.id), { headers: { authorization: `Bearer ${secret}` } });

    expect(byMember.status).toBe(403);
    expect((await byMember.json()).error.code).toBe("not_admin");
    expect(byAgent.status).toBe(403);
    expect((await byAgent.json()).error.code).toBe("agent_not_allowed");
    expect(await latestImport(member.cookie, project.id, repository.id)).toBeNull();
  });

  test("a Repository the Project doesn't list is refused", async () => {
    const { cookie, project, installation } = await projectListingRepository();
    installation.repositories.push({ id: 990001, name: "docs", fullName: "cronkcorp/docs" });

    const refused = await cronk.request("POST", importPath(project.id, 990001), { cookie });

    expect(refused.status).toBe(404);
  });

  test("an import while the App's installation can't read issues is refused, pointing to the GitHub page", async () => {
    const { cookie, installation, repository, project } = await projectListingRepository();
    const { issues: _issues, ...withoutIssues } = installation.permissions;
    installation.permissions = withoutIssues;
    cronk.github.issue(repository, { title: "An issue" });

    const refused = await cronk.request("POST", importPath(project.id, repository.id), { cookie });

    expect(refused.status).toBe(409);
    const { error } = await refused.json();
    expect(error.code).toBe("issues_permission_missing");
    expect(error.message).toMatch(/GitHub page/);
    expect(await latestImport(cookie, project.id, repository.id)).toBeNull();

    installation.accept();
    await startImport(cookie, project.id, repository.id);
    expect(await runImportsToEnd(cookie, project.id, repository.id)).toMatchObject({ state: "done", imported: 1 });
  });

  test("an import GitHub stops letting the App read fails, saying why", async () => {
    const { cookie, installation, repository, project } = await projectListingRepository();
    cronk.github.issue(repository, { title: "An issue" });
    await startImport(cookie, project.id, repository.id);

    installation.permissions = { ...installation.permissions, issues: "none" };
    const ended = await runImportsToEnd(cookie, project.id, repository.id);

    expect(ended).toMatchObject({ state: "failed", imported: 0, error: expect.stringMatching(/Issues \(read\)/) });
    expect(await ticketsOf(cookie, project.id)).toEqual([]);
  });

  test("an import GitHub can't answer for the moment carries on at the next pass", async () => {
    const { cookie, repository, project } = await projectListingRepository();
    cronk.github.issue(repository, { title: "An issue" });
    await startImport(cookie, project.id, repository.id);

    cronk.github.unavailable = true;
    await expect(cronk.runImports()).rejects.toThrow();
    cronk.github.unavailable = false;

    expect(await runImportsToEnd(cookie, project.id, repository.id)).toMatchObject({ state: "done", imported: 1 });
  });
});
