import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { minutes } from "../harness/clock.js";
import { addMember, createGitHubApp, linkGitHub, setUp, signIn } from "../harness/flows.js";
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

async function commentsOf(cookie: string, ticketId: string) {
  const response = await cronk.request("GET", `/api/tickets/${ticketId}/comments`, { cookie });
  expect(response.status).toBe(200);
  return response.json();
}

/** A member of the Workspace who has linked a GitHub account, and the account. */
async function memberWithGitHub(cookie: string, workspaceId: string, email: string, login: string) {
  const member = await addMember(cronk, cookie, workspaceId, email);
  const account = cronk.github.account(login);
  await linkGitHub(cronk, member.cookie, account);
  return { ...member, account };
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
        to: { source: "github", url: `${cronk.github.url}/cronkcorp/cronker/issues/1`, author: { login: "octocat" } },
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

  const issuesCalls = () => cronk.github.apiCalls.filter((call) => /^GET \/repos\/.+\/issues$/.test(call)).length;

  test("an import GitHub rate-limits waits until the limit lifts, shows it, then carries on where it left off", async () => {
    const { cookie, repository, project } = await projectListingRepository();
    for (let n = 1; n <= 250; n++) cronk.github.issue(repository, { title: `Issue ${n}`, createdAt: new Date(Date.UTC(2024, 0, 1, 0, n)) });
    await startImport(cookie, project.id, repository.id);
    await cronk.runImports();
    expect(await latestImport(cookie, project.id, repository.id)).toMatchObject({ imported: 100, waitingUntil: null });

    const lifts = new Date(cronk.clock.now().getTime() + minutes(20));
    cronk.github.rateLimitIssues(lifts);
    await cronk.runImports();
    expect(await latestImport(cookie, project.id, repository.id)).toMatchObject({
      state: "running",
      imported: 100,
      waitingUntil: lifts.toISOString(),
    });
    const callsWhileWaiting = issuesCalls();
    cronk.clock.advance(minutes(19));
    await cronk.runImports();
    expect(issuesCalls()).toBe(callsWhileWaiting);

    cronk.clock.advance(minutes(1));
    const ended = await runImportsToEnd(cookie, project.id, repository.id);

    expect(ended).toMatchObject({ state: "done", imported: 250, skipped: 0, waitingUntil: null });
    const titles = (await ticketsOf(cookie, project.id)).map((t: { title: string }) => t.title).sort();
    expect(titles).toEqual(Array.from({ length: 250 }, (_, i) => `Issue ${i + 1}`).sort());
  });

  test("a 429 with Retry-After waits that long", async () => {
    const { cookie, repository, project } = await projectListingRepository();
    cronk.github.issue(repository, { title: "An issue" });
    await startImport(cookie, project.id, repository.id);

    const lifts = new Date(cronk.clock.now().getTime() + minutes(2));
    cronk.github.rateLimitIssues(lifts, { status: 429, header: "retry-after" });
    await cronk.runImports();
    expect(await latestImport(cookie, project.id, repository.id)).toMatchObject({ state: "running", imported: 0, waitingUntil: lifts.toISOString() });

    cronk.clock.advance(minutes(2));
    expect(await runImportsToEnd(cookie, project.id, repository.id)).toMatchObject({ state: "done", imported: 1, waitingUntil: null });
  });
});

describe("importing an issue's Comments and people", () => {
  test("each Comment comes in as a Comment, in order, at GitHub's time", async () => {
    const { cookie, repository, project } = await projectListingRepository();
    const stranger = cronk.github.account("stranger");
    const times = [new Date("2024-03-02T09:00:00Z"), new Date("2024-03-02T10:00:00Z"), new Date("2024-03-03T08:30:00Z")];
    cronk.github.issue(repository, {
      title: "Open bug",
      createdAt: new Date("2024-03-01T10:00:00Z"),
      comments: times.map((createdAt, n) => ({ author: stranger, body: `Comment ${n + 1}`, createdAt })),
    });
    cronk.github.issue(repository, { title: "Quiet", createdAt: new Date("2024-03-04T10:00:00Z") });

    await startImport(cookie, project.id, repository.id);
    await runImportsToEnd(cookie, project.id, repository.id);

    const tickets = await ticketsOf(cookie, project.id);
    const byTitle = Object.fromEntries(tickets.map((t: { title: string }) => [t.title, t]));
    const comments = await commentsOf(cookie, byTitle["Open bug"].id);
    expect(comments.map((c: { body: string; createdAt: string }) => [c.body, c.createdAt])).toEqual(
      times.map((at, n) => [`Comment ${n + 1}`, at.toISOString()]),
    );
    expect(comments.every((c: { sentBack: boolean; replyToId: string | null }) => !c.sentBack && c.replyToId === null)).toBe(true);
    expect(await commentsOf(cookie, byTitle["Quiet"].id)).toEqual([]);
  });

  test("an issue with more Comments than one page brings them all", async () => {
    const { cookie, repository, project } = await projectListingRepository();
    cronk.github.issue(repository, {
      comments: Array.from({ length: 130 }, (_, n) => ({ author: null, body: `Comment ${n + 1}`, createdAt: new Date(Date.UTC(2024, 0, 1, 0, n)) })),
    });

    await startImport(cookie, project.id, repository.id);
    await runImportsToEnd(cookie, project.id, repository.id);

    const [ticket] = await ticketsOf(cookie, project.id);
    const comments = await commentsOf(cookie, ticket.id);
    expect(comments).toHaveLength(130);
    expect([comments[0].body, comments[129].body]).toEqual(["Comment 1", "Comment 130"]);
  });

  test("authors are matched to Users by linked GitHub account; others show as their login on GitHub", async () => {
    const { workspace, cookie, user, repository, project } = await projectListingRepository();
    const grace = await memberWithGitHub(cookie, workspace.id, "grace@example.com", "grace");
    const stranger = cronk.github.account("stranger");
    const at = new Date("2024-03-02T09:00:00Z");
    cronk.github.issue(repository, {
      title: "By Grace",
      author: grace.account,
      comments: [
        { author: stranger, body: "Me too", createdAt: at },
        { author: grace.account, body: "Thanks", createdAt: new Date("2024-03-02T10:00:00Z") },
        { author: null, body: "Gone", createdAt: new Date("2024-03-02T11:00:00Z") },
      ],
    });
    cronk.github.issue(repository, { title: "By a stranger", author: stranger });

    await startImport(cookie, project.id, repository.id);
    await runImportsToEnd(cookie, project.id, repository.id);

    const tickets = await ticketsOf(cookie, project.id);
    const byTitle = Object.fromEntries(tickets.map((t: { title: string }) => [t.title, t]));
    expect(byTitle["By Grace"].createdBy).toBe(grace.user.id);
    expect(byTitle["By a stranger"].createdBy).toBe(user.id);

    const [graces] = await timelineOf(cookie, byTitle["By Grace"].id);
    expect(graces).toMatchObject({ actor: { kind: "user", id: user.id }, to: { author: { id: grace.user.id, name: "grace@example.com" } } });
    const [strangers] = await timelineOf(cookie, byTitle["By a stranger"].id);
    expect(strangers).toMatchObject({ actor: { kind: "user", id: user.id }, to: { author: { login: "stranger" } } });

    const comments = await commentsOf(cookie, byTitle["By Grace"].id);
    expect(comments.map((c: { actor: unknown }) => c.actor)).toEqual([
      { kind: "github", login: "stranger", name: "@stranger on GitHub" },
      expect.objectContaining({ kind: "user", id: grace.user.id }),
      { kind: "github", login: "ghost", name: "@ghost on GitHub" },
    ]);
  });

  test("a GitHub account whose User isn't a member of the Workspace counts as having no User", async () => {
    const { workspace, cookie, user, repository, project } = await projectListingRepository();
    const bea = await memberWithGitHub(cookie, workspace.id, "bea@example.com", "bea");
    const removed = await cronk.request("DELETE", `/api/workspaces/${workspace.id}/members/${bea.user.id}`, { cookie });
    expect(removed.status, await removed.clone().text()).toBeLessThan(300);
    cronk.github.issue(repository, {
      author: bea.account,
      assignees: [bea.account],
      comments: [{ author: bea.account, body: "Hi", createdAt: new Date("2024-03-02T09:00:00Z") }],
    });

    await startImport(cookie, project.id, repository.id);
    const ended = await runImportsToEnd(cookie, project.id, repository.id);

    const [ticket] = await ticketsOf(cookie, project.id);
    expect(ticket).toMatchObject({ createdBy: user.id, assigneeId: null });
    const [comment] = await commentsOf(cookie, ticket.id);
    expect(comment.actor).toEqual({ kind: "github", login: "bea", name: "@bea on GitHub" });
    expect(ended.unmatchedAuthors).toEqual(["bea"]);
  });

  test("the first assignee with a User becomes the Assignee; assignees with none are dropped and no User is created", async () => {
    const { workspace, cookie, user, repository, project } = await projectListingRepository();
    const grace = await memberWithGitHub(cookie, workspace.id, "grace@example.com", "grace");
    const hal = await memberWithGitHub(cookie, workspace.id, "hal@example.com", "hal");
    const stranger = cronk.github.account("stranger");
    const membersBefore = await (await cronk.request("GET", `/api/workspaces/${workspace.id}/members`, { cookie })).json();
    cronk.github.issue(repository, { title: "Shared", assignees: [stranger, grace.account, hal.account] });
    cronk.github.issue(repository, { title: "Stranger's", assignees: [stranger] });

    await startImport(cookie, project.id, repository.id);
    await runImportsToEnd(cookie, project.id, repository.id);

    const tickets = await ticketsOf(cookie, project.id);
    const byTitle = Object.fromEntries(tickets.map((t: { title: string }) => [t.title, t]));
    expect(byTitle["Shared"]).toMatchObject({ assigneeId: grace.user.id, delegateId: null });
    expect(byTitle["Stranger's"]).toMatchObject({ assigneeId: null });
    const timeline = await timelineOf(cookie, byTitle["Shared"].id);
    expect(timeline.map((c: { field: string }) => c.field)).toEqual(["created", "assignee"]);
    expect(timeline[1]).toMatchObject({ actor: { kind: "user", id: user.id }, from: null, to: { id: grace.user.id } });
    const membersAfter = await (await cronk.request("GET", `/api/workspaces/${workspace.id}/members`, { cookie })).json();
    expect(membersAfter).toEqual(membersBefore);
  });

  test("the summary lists the authors with no User, once each, alphabetical, across pages and runs", async () => {
    const { workspace, cookie, repository, project } = await projectListingRepository();
    const grace = await memberWithGitHub(cookie, workspace.id, "grace@example.com", "grace");
    const zed = cronk.github.account("zed");
    const amy = cronk.github.account("amy");
    const assigned = cronk.github.account("assigned");
    for (let n = 1; n <= 101; n++) {
      cronk.github.issue(repository, {
        author: n === 101 ? amy : grace.account,
        assignees: [assigned],
        createdAt: new Date(Date.UTC(2024, 0, 1, 0, n)),
        comments: n === 1 ? [{ author: zed, body: "First", createdAt: new Date(Date.UTC(2024, 0, 2)) }] : [],
      });
    }

    await startImport(cookie, project.id, repository.id);
    await cronk.runImports();
    expect(await latestImport(cookie, project.id, repository.id)).toMatchObject({ state: "running", unmatchedAuthors: ["zed"] });
    const ended = await runImportsToEnd(cookie, project.id, repository.id);

    expect(ended).toMatchObject({ state: "done", imported: 101, unmatchedAuthors: ["amy", "zed"] });
  });

  test("importing again adds no Comments to Tickets imported before", async () => {
    const { cookie, repository, project } = await projectListingRepository();
    const issue = cronk.github.issue(repository, { comments: [{ author: null, body: "First", createdAt: new Date("2024-03-02T09:00:00Z") }] });
    await startImport(cookie, project.id, repository.id);
    await runImportsToEnd(cookie, project.id, repository.id);

    issue.comments.push({ author: null, body: "Second", createdAt: new Date("2024-03-03T09:00:00Z") });
    await startImport(cookie, project.id, repository.id);
    const ended = await runImportsToEnd(cookie, project.id, repository.id);

    expect(ended).toMatchObject({ imported: 0, skipped: 1 });
    const [ticket] = await ticketsOf(cookie, project.id);
    expect((await commentsOf(cookie, ticket.id)).map((c: { body: string }) => c.body)).toEqual(["First"]);
  });

  test("an import whose Comments GitHub rate-limits waits, keeping nothing of the page, then brings them all", async () => {
    const { cookie, repository, project } = await projectListingRepository();
    cronk.github.issue(repository, { title: "First", comments: [{ author: null, body: "Hi", createdAt: new Date("2024-03-02T09:00:00Z") }] });
    cronk.github.issue(repository, { title: "Second", comments: [{ author: null, body: "Yo", createdAt: new Date("2024-03-03T09:00:00Z") }] });
    await startImport(cookie, project.id, repository.id);

    const lifts = new Date(cronk.clock.now().getTime() + minutes(5));
    cronk.github.rateLimitIssues(lifts, { only: "comments" });
    await cronk.runImports();
    expect(await latestImport(cookie, project.id, repository.id)).toMatchObject({ state: "running", imported: 0, waitingUntil: lifts.toISOString() });
    expect(await ticketsOf(cookie, project.id)).toEqual([]);

    cronk.clock.advance(minutes(5));
    const ended = await runImportsToEnd(cookie, project.id, repository.id);

    expect(ended).toMatchObject({ state: "done", imported: 2, waitingUntil: null });
    for (const ticket of await ticketsOf(cookie, project.id)) expect(await commentsOf(cookie, ticket.id)).toHaveLength(1);
  });

  test("an import GitHub stops letting read an issue's Comments fails, keeping nothing of that page", async () => {
    const { cookie, repository, project } = await projectListingRepository();
    cronk.github.issue(repository, { title: "Readable" });
    cronk.github.issue(repository, { title: "Hidden", commentsRefused: true });
    await startImport(cookie, project.id, repository.id);

    const ended = await runImportsToEnd(cookie, project.id, repository.id);

    expect(ended).toMatchObject({ state: "failed", imported: 0, error: expect.stringMatching(/Comments of cronkcorp\/cronker#2/) });
    expect(await ticketsOf(cookie, project.id)).toEqual([]);
  });
});
