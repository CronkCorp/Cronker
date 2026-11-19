import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { hours } from "../harness/clock.js";
import { addMember, createGitHubApp, setUp, signIn, signInWithGitHub } from "../harness/flows.js";
import type { StandInApp, StandInInstallation, StandInRepository } from "../harness/github.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";
import { openStream } from "../harness/stream.js";

let cronk: StartedCronk;
beforeEach(async () => {
  cronk = await startCronk();
});
afterEach(async () => {
  await cronk?.stop();
});

async function post(cookie: string, path: string, body: unknown) {
  const response = await cronk.request("POST", path, { cookie, body });
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json();
}

/** Ada's Workspace with the GitHub App installed on `cronkcorp`'s `cronker` and `website`, and Project CRONK listing `cronker`. */
async function projectWithRepository() {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  await createGitHubApp(cronk, cookie);
  const app = cronk.github.apps[0]!;
  const installation = cronk.github.install(app, "cronkcorp", ["cronker", "website"]);
  const [cronker, website] = [installation.repositories[0]!, installation.repositories[1]!];
  const project = await post(cookie, `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  await post(cookie, `/api/projects/${project.id}/repositories`, { id: cronker.id });
  return { workspace, cookie, app, installation, project, cronker, website };
}

interface PullRequestFields {
  id: number;
  number: number;
  title: string;
  branch: string;
  sha?: string;
  state?: "open" | "closed";
  draft?: boolean;
  merged?: boolean;
  /** The GitHub account that merged it; GitHub's merge queue merges as its own bot. */
  mergedBy?: { login: string; id: number; type?: string };
  /** Set while auto-merge is on, naming who turned it on. */
  autoMerge?: { enabled_by: { login: string; id: number } };
  updatedAt?: string;
}

/** A `pull_request` delivery as GitHub sends it, with only the fields Cronk reads. */
function pullRequestEvent(
  action: string,
  installation: StandInInstallation,
  repository: StandInRepository,
  pr: PullRequestFields,
) {
  return {
    action,
    installation: { id: installation.id },
    repository: { id: repository.id, full_name: repository.fullName },
    pull_request: {
      id: pr.id,
      number: pr.number,
      title: pr.title,
      state: pr.state ?? "open",
      draft: pr.draft ?? false,
      merged: pr.merged ?? false,
      merged_by: pr.mergedBy ? { type: "User", ...pr.mergedBy } : null,
      auto_merge: pr.autoMerge ?? null,
      html_url: `https://github.com/${repository.fullName}/pull/${pr.number}`,
      head: { ref: pr.branch, sha: pr.sha ?? "aaaa" },
      updated_at: pr.updatedAt ?? "2026-01-01T09:00:00Z",
    },
  };
}

async function deliver(app: StandInApp, event: string, payload: unknown) {
  const delivered = await cronk.github.deliver(app, event, payload);
  expect(delivered.status, await delivered.clone().text()).toBe(200);
}

const pullRequestsOf = async (ticketId: string, cookie: string) => {
  const response = await cronk.request("GET", `/api/tickets/${ticketId}/pull-requests`, { cookie });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json();
};

describe("Pull Requests linking to Tickets", () => {
  test("a Pull Request links to the Tickets whose keys its branch or title contains", async () => {
    const { cookie, app, installation, project, cronker } = await projectWithRepository();
    const first = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "By branch" });
    const second = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "By title" });
    const third = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Not named" });

    await deliver(
      app,
      "pull_request",
      pullRequestEvent("opened", installation, cronker, { id: 501, number: 7, title: "Fix CRONK-2 too", branch: "feat/cronk-1-fix" }),
    );

    const shown = {
      id: 501,
      repository: "cronkcorp/cronker",
      number: 7,
      title: "Fix CRONK-2 too",
      branch: "feat/cronk-1-fix",
      url: "https://github.com/cronkcorp/cronker/pull/7",
      state: "open",
      checks: [],
      mergedBy: null,
      producingStep: null,
    };
    expect(await pullRequestsOf(first.id, cookie)).toEqual([shown]);
    expect(await pullRequestsOf(second.id, cookie)).toEqual([shown]);
    expect(await pullRequestsOf(third.id, cookie)).toEqual([]);
  });

  test("a key named in both title and branch, in any case, links its Ticket once", async () => {
    const { cookie, app, installation, project, cronker } = await projectWithRepository();
    const ticket = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Named twice" });

    await deliver(
      app,
      "pull_request",
      pullRequestEvent("opened", installation, cronker, { id: 501, number: 7, title: "CRONK-1: twice", branch: "cronk-1" }),
    );

    expect((await pullRequestsOf(ticket.id, cookie)).map((pr: { id: number }) => pr.id)).toEqual([501]);
  });

  test("a key joined to the rest of a branch name by underscores still links", async () => {
    const { cookie, app, installation, project, cronker } = await projectWithRepository();
    const ticket = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Underscored" });

    await deliver(
      app,
      "pull_request",
      pullRequestEvent("opened", installation, cronker, { id: 501, number: 7, title: "Fix login", branch: "feat_CRONK-1_fix-login" }),
    );

    expect((await pullRequestsOf(ticket.id, cookie)).map((pr: { id: number }) => pr.id)).toEqual([501]);
  });

  test("only Projects listing the Pull Request's Repository get links, and a Repository no Project lists links nothing", async () => {
    const { workspace, cookie, app, installation, project, cronker, website } = await projectWithRepository();
    const listed = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Listed" });
    const other = await post(cookie, `/api/workspaces/${workspace.id}/projects`, { name: "Website", key: "WEB" });
    const unlisted = await post(cookie, `/api/projects/${other.id}/tickets`, { title: "Not listing cronker" });

    await deliver(
      app,
      "pull_request",
      pullRequestEvent("opened", installation, cronker, { id: 501, number: 7, title: "CRONK-1 and WEB-1", branch: "both" }),
    );
    await deliver(
      app,
      "pull_request",
      pullRequestEvent("opened", installation, website, { id: 502, number: 1, title: "CRONK-1 on the website", branch: "web-1" }),
    );

    expect((await pullRequestsOf(listed.id, cookie)).map((pr: { id: number }) => pr.id)).toEqual([501]);
    expect(await pullRequestsOf(unlisted.id, cookie)).toEqual([]);
  });

  test("Projects of other Workspaces sharing the key on the Repository all get the link, each seeing only its own Ticket", async () => {
    const { cookie, app, installation, project, cronker } = await projectWithRepository();
    const ours = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Ada's" });
    const other = await post(cookie, "/api/workspaces", { name: "Bea's Workspace" });
    const bea = await addMember(cronk, cookie, other.id, "bea@example.com");
    const beasProject = await post(bea.cookie, `/api/workspaces/${other.id}/projects`, { name: "Bea's", key: "cronk" });
    await post(bea.cookie, `/api/projects/${beasProject.id}/repositories`, { id: cronker.id });
    const theirs = await post(bea.cookie, `/api/projects/${beasProject.id}/tickets`, { title: "Bea's" });

    await deliver(
      app,
      "pull_request",
      pullRequestEvent("opened", installation, cronker, { id: 501, number: 7, title: "Fix", branch: "CRONK-1" }),
    );

    expect((await pullRequestsOf(ours.id, cookie)).map((pr: { id: number }) => pr.id)).toEqual([501]);
    expect((await pullRequestsOf(theirs.id, bea.cookie)).map((pr: { id: number }) => pr.id)).toEqual([501]);
    const across = await cronk.request("GET", `/api/tickets/${ours.id}/pull-requests`, { cookie: bea.cookie });
    expect(across.status).toBe(404);
  });
});

describe("Pull Requests edited on GitHub", () => {
  test("editing the title or branch to name another key adds a link and keeps the existing ones", async () => {
    const { cookie, app, installation, project, cronker } = await projectWithRepository();
    const [first, second, third] = [
      await post(cookie, `/api/projects/${project.id}/tickets`, { title: "First" }),
      await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Second" }),
      await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Third" }),
    ];
    const pr = { id: 501, number: 7, title: "CRONK-1: start", branch: "start" };
    await deliver(app, "pull_request", pullRequestEvent("opened", installation, cronker, pr));

    await deliver(
      app,
      "pull_request",
      pullRequestEvent("edited", installation, cronker, { ...pr, title: "CRONK-2: renamed", updatedAt: "2026-01-01T10:00:00Z" }),
    );
    await deliver(
      app,
      "pull_request",
      pullRequestEvent("edited", installation, cronker, {
        ...pr,
        title: "CRONK-2: renamed",
        branch: "cronk-3-moved",
        updatedAt: "2026-01-01T11:00:00Z",
      }),
    );

    for (const ticket of [first, second, third]) {
      expect(await pullRequestsOf(ticket.id, cookie)).toMatchObject([{ id: 501, title: "CRONK-2: renamed", branch: "cronk-3-moved" }]);
    }
  });
});

describe("A Pull Request's state", () => {
  test("shows draft, open once ready, closed when closed unmerged, and merged", async () => {
    const { cookie, app, installation, project, cronker } = await projectWithRepository();
    const ticket = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Stateful" });
    const pr = { id: 501, number: 7, title: "CRONK-1", branch: "b" };
    const stateAfter = async (action: string, fields: Partial<PullRequestFields>, updatedAt: string) => {
      await deliver(app, "pull_request", pullRequestEvent(action, installation, cronker, { ...pr, ...fields, updatedAt }));
      return (await pullRequestsOf(ticket.id, cookie))[0].state;
    };

    expect(await stateAfter("opened", { draft: true }, "2026-01-01T09:00:00Z")).toBe("draft");
    expect(await stateAfter("ready_for_review", {}, "2026-01-01T10:00:00Z")).toBe("open");
    expect(await stateAfter("closed", { state: "closed" }, "2026-01-01T11:00:00Z")).toBe("closed");
    expect(await stateAfter("reopened", {}, "2026-01-01T12:00:00Z")).toBe("open");
    expect(await stateAfter("closed", { state: "closed", merged: true }, "2026-01-01T13:00:00Z")).toBe("merged");
  });

  test("a delivery arriving after a newer one leaves the newer state", async () => {
    const { cookie, app, installation, project, cronker } = await projectWithRepository();
    const ticket = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Late" });
    const pr = { id: 501, number: 7, title: "CRONK-1", branch: "b" };

    await deliver(app, "pull_request", pullRequestEvent("ready_for_review", installation, cronker, { ...pr, updatedAt: "2026-01-01T10:00:00Z" }));
    await deliver(
      app,
      "pull_request",
      pullRequestEvent("opened", installation, cronker, { ...pr, title: "CRONK-1 old title", draft: true, updatedAt: "2026-01-01T09:00:00Z" }),
    );

    expect(await pullRequestsOf(ticket.id, cookie)).toMatchObject([{ state: "open", title: "CRONK-1" }]);
  });

  test("opening, becoming ready or closing unmerged never moves a Ticket", async () => {
    const { cookie, app, installation, project, cronker } = await projectWithRepository();
    const ticket = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Stays put" });
    const pr = { id: 501, number: 7, title: "CRONK-1", branch: "b" };

    await deliver(app, "pull_request", pullRequestEvent("opened", installation, cronker, { ...pr, draft: true, updatedAt: "2026-01-01T09:00:00Z" }));
    await deliver(app, "pull_request", pullRequestEvent("ready_for_review", installation, cronker, { ...pr, updatedAt: "2026-01-01T10:00:00Z" }));
    await deliver(app, "pull_request", pullRequestEvent("closed", installation, cronker, { ...pr, state: "closed", updatedAt: "2026-01-01T11:00:00Z" }));

    const after = await (await cronk.request("GET", `/api/tickets/${ticket.id}`, { cookie })).json();
    expect(after.statusId).toBe(ticket.statusId);
    const changes = await (await cronk.request("GET", `/api/tickets/${ticket.id}/timeline`, { cookie })).json();
    expect(changes).toHaveLength(1);
  });
});


describe("A Pull Request's checks", () => {
  const checkRunEvent = (
    installation: StandInInstallation,
    repository: StandInRepository,
    run: { id: number; name: string; sha: string; status: string; conclusion?: string },
  ) => ({
    action: run.status === "completed" ? "completed" : "created",
    installation: { id: installation.id },
    repository: { id: repository.id, full_name: repository.fullName },
    check_run: {
      id: run.id,
      name: run.name,
      head_sha: run.sha,
      status: run.status,
      conclusion: run.conclusion ?? null,
      html_url: `https://github.com/${repository.fullName}/runs/${run.id}`,
    },
  });
  const statusEvent = (
    installation: StandInInstallation,
    repository: StandInRepository,
    status: { id: number; context: string; sha: string; state: string },
  ) => ({
    installation: { id: installation.id },
    repository: { id: repository.id, full_name: repository.fullName },
    id: status.id,
    sha: status.sha,
    context: status.context,
    state: status.state,
    target_url: null,
  });

  test("shows the check runs and commit statuses on its latest commit, the latest of each", async () => {
    const { cookie, app, installation, project, cronker } = await projectWithRepository();
    const ticket = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Checked" });
    await deliver(app, "pull_request", pullRequestEvent("opened", installation, cronker, { id: 501, number: 7, title: "CRONK-1", branch: "b", sha: "c1" }));

    await deliver(app, "check_run", checkRunEvent(installation, cronker, { id: 10, name: "test", sha: "c1", status: "in_progress" }));
    await deliver(app, "check_run", checkRunEvent(installation, cronker, { id: 11, name: "lint", sha: "c1", status: "completed", conclusion: "timed_out" }));
    await deliver(app, "check_run", checkRunEvent(installation, cronker, { id: 12, name: "skip", sha: "c1", status: "completed", conclusion: "skipped" }));
    await deliver(app, "status", statusEvent(installation, cronker, { id: 20, context: "ci/build", sha: "c1", state: "pending" }));
    await deliver(app, "status", statusEvent(installation, cronker, { id: 21, context: "ci/build", sha: "c1", state: "error" }));
    await deliver(app, "check_run", checkRunEvent(installation, cronker, { id: 10, name: "test", sha: "c1", status: "completed", conclusion: "success" }));
    // Another commit's checks don't show.
    await deliver(app, "check_run", checkRunEvent(installation, cronker, { id: 13, name: "other", sha: "zz", status: "queued" }));

    expect((await pullRequestsOf(ticket.id, cookie))[0].checks).toEqual([
      { name: "ci/build", state: "failed", url: null },
      { name: "lint", state: "failed", url: "https://github.com/cronkcorp/cronker/runs/11" },
      { name: "skip", state: "neutral", url: "https://github.com/cronkcorp/cronker/runs/12" },
      { name: "test", state: "passed", url: "https://github.com/cronkcorp/cronker/runs/10" },
    ]);
  });

  test("a rerun replaces the run before it, a late delivery changes nothing, and a new commit starts afresh", async () => {
    const { cookie, app, installation, project, cronker } = await projectWithRepository();
    const ticket = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Rerun" });
    const pr = { id: 501, number: 7, title: "CRONK-1", branch: "b" };
    await deliver(app, "pull_request", pullRequestEvent("opened", installation, cronker, { ...pr, sha: "c1" }));
    const checks = async () => (await pullRequestsOf(ticket.id, cookie))[0].checks.map((c: { name: string; state: string }) => [c.name, c.state]);

    await deliver(app, "check_run", checkRunEvent(installation, cronker, { id: 10, name: "test", sha: "c1", status: "completed", conclusion: "failure" }));
    await deliver(app, "check_run", checkRunEvent(installation, cronker, { id: 15, name: "test", sha: "c1", status: "queued" }));
    expect(await checks()).toEqual([["test", "pending"]]);

    await deliver(app, "check_run", checkRunEvent(installation, cronker, { id: 15, name: "test", sha: "c1", status: "completed", conclusion: "success" }));
    await deliver(app, "check_run", checkRunEvent(installation, cronker, { id: 15, name: "test", sha: "c1", status: "in_progress" }));
    await deliver(app, "check_run", checkRunEvent(installation, cronker, { id: 10, name: "test", sha: "c1", status: "completed", conclusion: "failure" }));
    expect(await checks()).toEqual([["test", "passed"]]);

    await deliver(app, "pull_request", pullRequestEvent("synchronize", installation, cronker, { ...pr, sha: "c2", updatedAt: "2026-01-01T10:00:00Z" }));
    expect(await checks()).toEqual([]);
  });
});

describe("Pull Requests updating live", () => {
  test("a Ticket's Workspace hears its Pull Requests changed when one links, changes state or gets a check", async () => {
    const { workspace, cookie, app, installation, project, cronker } = await projectWithRepository();
    const ticket = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Live" });
    const stream = await openStream(cronk, cookie, workspace.id);
    const changed = { type: "pull_requests.changed", data: { projectId: project.id, ticketId: ticket.id } };
    const pr = { id: 501, number: 7, title: "CRONK-1", branch: "b", sha: "c1" };

    await deliver(app, "pull_request", pullRequestEvent("opened", installation, cronker, pr));
    expect(await stream.next()).toEqual(changed);
    await deliver(app, "pull_request", pullRequestEvent("closed", installation, cronker, { ...pr, state: "closed", updatedAt: "2026-01-01T10:00:00Z" }));
    expect(await stream.next()).toEqual(changed);
    await deliver(app, "status", {
      installation: { id: installation.id },
      repository: { id: cronker.id, full_name: cronker.fullName },
      id: 20,
      sha: "c1",
      context: "ci",
      state: "success",
      target_url: null,
    });
    expect(await stream.next()).toEqual(changed);
    stream.close();
  });
});

describe("The producing Step", () => {
  test("is the Step of the Run running on a Ticket when GitHub reports the Pull Request opened, and absent where none is", async () => {
    const { workspace, cookie, app, installation, project, cronker } = await projectWithRepository();
    const runner = await post(cookie, "/api/runners", { name: "Fake", kind: "fake" });
    const created = await post(cookie, `/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
    await cronk.request("PATCH", `/api/agents/${created.id}`, { cookie, body: { runnerId: runner.id } });
    const implement = project.statuses.find((s: { name: string }) => s.name === "Implement").id;
    const running = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Being implemented" });
    await cronk.request("PATCH", `/api/tickets/${running.id}`, { cookie, body: { delegateId: created.id, statusId: implement } });
    const [run] = await (await cronk.request("GET", `/api/tickets/${running.id}/runs`, { cookie })).json();
    expect(run.state).toBe("running");
    const idle = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Nobody on it" });

    await deliver(app, "pull_request", pullRequestEvent("opened", installation, cronker, { id: 501, number: 7, title: "CRONK-1 CRONK-2", branch: "b" }));

    expect((await pullRequestsOf(running.id, cookie))[0].producingStep).toEqual({ runId: run.id, statusId: implement, name: "Implement" });
    expect((await pullRequestsOf(idle.id, cookie))[0].producingStep).toBeNull();
  });

  test("is absent for a Ticket a later edit links, even with a Run running on it", async () => {
    const { workspace, cookie, app, installation, project, cronker } = await projectWithRepository();
    const runner = await post(cookie, "/api/runners", { name: "Fake", kind: "fake" });
    const created = await post(cookie, `/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
    await cronk.request("PATCH", `/api/agents/${created.id}`, { cookie, body: { runnerId: runner.id } });
    const implement = project.statuses.find((s: { name: string }) => s.name === "Implement").id;
    const ticket = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Linked later" });
    const pr = { id: 501, number: 7, title: "Untitled", branch: "b" };
    await deliver(app, "pull_request", pullRequestEvent("opened", installation, cronker, pr));
    await cronk.request("PATCH", `/api/tickets/${ticket.id}`, { cookie, body: { delegateId: created.id, statusId: implement } });

    await deliver(app, "pull_request", pullRequestEvent("edited", installation, cronker, { ...pr, title: "CRONK-1", updatedAt: "2026-01-01T10:00:00Z" }));

    expect(await pullRequestsOf(ticket.id, cookie)).toMatchObject([{ id: 501, producingStep: null }]);
  });
});

describe("Merges", () => {
  const ticketOf = async (ticketId: string, cookie: string) =>
    (await cronk.request("GET", `/api/tickets/${ticketId}`, { cookie })).json();
  const statusNamed = (project: { statuses: { id: string; name: string }[] }, name: string) =>
    project.statuses.find((s) => s.name === name)!.id;

  /** Bea, added to the Workspace by her GitHub login, joins by signing in with GitHub. */
  async function beaJoins(workspaceId: string, cookie: string) {
    const account = cronk.github.account("bea", "bea@example.com");
    const added = await cronk.request("POST", `/api/workspaces/${workspaceId}/members/github`, { cookie, body: { login: "bea" } });
    expect(added.status).toBe(201);
    const { cookie: beaCookie } = await signInWithGitHub(cronk, account);
    return { account, cookie: beaCookie! };
  }

  const merged = (pr: PullRequestFields, mergedBy: PullRequestFields["mergedBy"], fields: Partial<PullRequestFields> = {}) => ({
    ...pr,
    state: "closed" as const,
    merged: true,
    mergedBy,
    updatedAt: "2026-01-01T12:00:00Z",
    ...fields,
  });

  test("a merge by a User of the Workspace completes each linked Ticket as Verified, in the Project's first Done Status", async () => {
    const { workspace, cookie, app, installation, project, cronker } = await projectWithRepository();
    const bea = await beaJoins(workspace.id, cookie);
    const ticket = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Merge me" });
    // A second Done Status after the first: the first one on the board is where merges go.
    await post(cookie, `/api/projects/${project.id}/statuses`, { name: "Shipped", kind: "done" });
    const pr = { id: 501, number: 7, title: "CRONK-1", branch: "b" };
    await deliver(app, "pull_request", pullRequestEvent("opened", installation, cronker, pr));

    await deliver(app, "pull_request", pullRequestEvent("closed", installation, cronker, merged(pr, { login: "bea", id: bea.account.id })));

    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: statusNamed(project, "Done"), verification: "verified" });
  });

  test("a merge by anyone else, by auto-merge or by a merge queue completes the Ticket as Unverified, waiting in the Assignee's Inbox", async () => {
    const { workspace, cookie, app, installation, project, cronker } = await projectWithRepository();
    const bea = await beaJoins(workspace.id, cookie);
    const ada = (await (await cronk.request("GET", "/api/me", { cookie })).json()).user;
    const tickets = [];
    for (const title of ["Outsider", "Auto-merge", "Merge queue"]) {
      const ticket = await post(cookie, `/api/projects/${project.id}/tickets`, { title });
      await cronk.request("PATCH", `/api/tickets/${ticket.id}`, { cookie, body: { assigneeId: ada.id } });
      tickets.push(ticket);
    }
    const prs = [1, 2, 3].map((n) => ({ id: 500 + n, number: n, title: `CRONK-${n}`, branch: `b${n}` }));

    const beaAccount = { login: "bea", id: bea.account.id };
    cronk.clock.advance(hours(2));
    await deliver(app, "pull_request", pullRequestEvent("closed", installation, cronker, merged(prs[0]!, { login: "mallory", id: 666 })));
    // Bea turned auto-merge on; GitHub names her as the merger.
    await deliver(
      app,
      "pull_request",
      pullRequestEvent("closed", installation, cronker, merged(prs[1]!, beaAccount, { autoMerge: { enabled_by: beaAccount } })),
    );
    await deliver(
      app,
      "pull_request",
      pullRequestEvent("closed", installation, cronker, merged(prs[2]!, { login: "github-merge-queue[bot]", id: 9919, type: "Bot" })),
    );

    for (const ticket of tickets) {
      expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: statusNamed(project, "Done"), verification: "unverified" });
    }
    const inbox = await (await cronk.request("GET", `/api/workspaces/${workspace.id}/inbox`, { cookie })).json();
    // No Run opened these Pull Requests, so no Step completed the Tickets.
    const unverified = inbox.items.filter((i: { kind: string }) => i.kind === "unverified");
    expect(
      unverified.map((i: { ticket: { key: string }; completedBy: unknown; completedWithoutStep: boolean; since: string }) => [
        i.ticket.key,
        i.completedBy,
        i.completedWithoutStep,
        i.since,
      ]),
    ).toEqual([
      ["CRONK-1", null, true, "2026-01-01T11:00:00.000Z"],
      ["CRONK-2", null, true, "2026-01-01T11:00:00.000Z"],
      ["CRONK-3", null, true, "2026-01-01T11:00:00.000Z"],
    ]);
  });

  test("a merge leaves a Ticket already in a Done or Canceled Status alone", async () => {
    const { cookie, app, installation, project, cronker } = await projectWithRepository();
    const done = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Done already" });
    const canceled = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Canceled" });
    // Done here is the board's second Done Status, not the first, which a merge would move it to.
    const shipped = (await post(cookie, `/api/projects/${project.id}/statuses`, { name: "Shipped", kind: "done" })).statuses.find(
      (s: { name: string }) => s.name === "Shipped",
    ).id;
    await cronk.request("PATCH", `/api/tickets/${done.id}`, { cookie, body: { statusId: shipped } });
    await cronk.request("PATCH", `/api/tickets/${canceled.id}`, { cookie, body: { statusId: statusNamed(project, "Canceled") } });
    const timelineLength = async (id: string) => (await (await cronk.request("GET", `/api/tickets/${id}/timeline`, { cookie })).json()).length;
    const before = [await timelineLength(done.id), await timelineLength(canceled.id)];

    const pr = { id: 501, number: 7, title: "CRONK-1 CRONK-2", branch: "b" };
    await deliver(app, "pull_request", pullRequestEvent("closed", installation, cronker, merged(pr, { login: "mallory", id: 666 })));

    expect(await ticketOf(done.id, cookie)).toMatchObject({ statusId: shipped, verification: null });
    expect(await ticketOf(canceled.id, cookie)).toMatchObject({ statusId: statusNamed(project, "Canceled"), verification: null });
    expect([await timelineLength(done.id), await timelineLength(canceled.id)]).toEqual(before);
  });

  test("the first merge completes every Ticket it links, whatever their other Pull Requests and unfinished Sub-Tickets", async () => {
    const { cookie, app, installation, project, cronker } = await projectWithRepository();
    const parent = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Parent" });
    const other = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Other" });
    const subTicket = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Unfinished", parentId: parent.id });
    // Another Pull Request of the parent stays open.
    await deliver(app, "pull_request", pullRequestEvent("opened", installation, cronker, { id: 500, number: 6, title: "CRONK-1 part one", branch: "a" }));
    const pr = { id: 501, number: 7, title: "CRONK-1 and CRONK-2", branch: "b" };
    await deliver(app, "pull_request", pullRequestEvent("opened", installation, cronker, pr));

    await deliver(app, "pull_request", pullRequestEvent("closed", installation, cronker, merged(pr, { login: "mallory", id: 666 })));

    const done = statusNamed(project, "Done");
    expect(await ticketOf(parent.id, cookie)).toMatchObject({ statusId: done, verification: "unverified" });
    expect(await ticketOf(other.id, cookie)).toMatchObject({ statusId: done, verification: "unverified" });
    expect(await ticketOf(subTicket.id, cookie)).toMatchObject({ statusId: subTicket.statusId, verification: null });
  });

  test("a merge stops a Run running on the Ticket, as a move by a User does, and the Change names the Pull Request and its merger", async () => {
    const { workspace, cookie, app, installation, project, cronker } = await projectWithRepository();
    const runner = await post(cookie, "/api/runners", { name: "Fake", kind: "fake" });
    const agent = await post(cookie, `/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
    await cronk.request("PATCH", `/api/agents/${agent.id}`, { cookie, body: { runnerId: runner.id } });
    const ticket = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Being implemented" });
    await cronk.request("PATCH", `/api/tickets/${ticket.id}`, { cookie, body: { delegateId: agent.id, statusId: statusNamed(project, "Implement") } });
    const pr = { id: 501, number: 7, title: "CRONK-1: make it so", branch: "b" };
    await deliver(app, "pull_request", pullRequestEvent("opened", installation, cronker, pr));

    await deliver(app, "pull_request", pullRequestEvent("closed", installation, cronker, merged(pr, { login: "mallory", id: 666 })));

    const [run] = await (await cronk.request("GET", `/api/tickets/${ticket.id}/runs`, { cookie })).json();
    expect(run).toMatchObject({ state: "stopped", endReason: "@mallory merged cronkcorp/cronker#7, completing CRONK-1." });
    expect(cronk.runner.stops.map((s) => s.runId)).toEqual([run.id]);
    const changes = await (await cronk.request("GET", `/api/tickets/${ticket.id}/timeline`, { cookie })).json();
    const byCronk = changes.filter((c: { actor: { kind: string } }) => c.actor.kind === "cronk");
    expect(byCronk.map((c: { field: string; from: unknown; to: unknown }) => [c.field, c.from, c.to])).toEqual([
      [
        "merged",
        null,
        {
          pullRequest: { id: 501, repository: "cronkcorp/cronker", number: 7, title: "CRONK-1: make it so", url: "https://github.com/cronkcorp/cronker/pull/7" },
          mergedBy: "mallory",
        },
      ],
      ["status", { id: statusNamed(project, "Implement"), name: "Implement" }, { id: statusNamed(project, "Done"), name: "Done" }],
      ["verification", null, "unverified"],
    ]);
  });

  test("Reopening an Unverified Ticket a merge completed sends it back to the producing Step's Status, or leaves it where it is without one", async () => {
    const { workspace, cookie, app, installation, project, cronker } = await projectWithRepository();
    const runner = await post(cookie, "/api/runners", { name: "Fake", kind: "fake" });
    const agent = await post(cookie, `/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
    await cronk.request("PATCH", `/api/agents/${agent.id}`, { cookie, body: { runnerId: runner.id } });
    const implement = statusNamed(project, "Implement");
    const produced = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Opened by a Run" });
    await cronk.request("PATCH", `/api/tickets/${produced.id}`, { cookie, body: { delegateId: agent.id, statusId: implement } });
    const byHand = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Opened by a User" });
    await deliver(app, "pull_request", pullRequestEvent("opened", installation, cronker, { id: 501, number: 7, title: "CRONK-1", branch: "a" }));
    await deliver(app, "pull_request", pullRequestEvent("opened", installation, cronker, { id: 502, number: 8, title: "CRONK-2", branch: "b" }));
    const mallory = { login: "mallory", id: 666 };
    await deliver(app, "pull_request", pullRequestEvent("closed", installation, cronker, merged({ id: 501, number: 7, title: "CRONK-1", branch: "a" }, mallory)));
    await deliver(app, "pull_request", pullRequestEvent("closed", installation, cronker, merged({ id: 502, number: 8, title: "CRONK-2", branch: "b" }, mallory)));

    // Each says what completed it and where Reopen sends it.
    const completionOf = async (id: string) => (await cronk.request("GET", `/api/tickets/${id}/completion`, { cookie })).json();
    const mergeOf = (number: number) => ({
      pullRequest: { id: 500 + number - 6, repository: "cronkcorp/cronker", number, title: `CRONK-${number - 6}`, url: `https://github.com/cronkcorp/cronker/pull/${number}` },
      mergedBy: "mallory",
    });
    expect(await completionOf(produced.id)).toEqual({ merge: mergeOf(7), reopen: { kind: "back", status: { id: implement, name: "Implement" } } });
    expect(await completionOf(byHand.id)).toEqual({ merge: mergeOf(8), reopen: { kind: "stays" } });

    const reopen = (id: string) =>
      cronk.request("POST", `/api/tickets/${id}/reopen`, { cookie, body: { comment: "Not quite." } });
    expect((await reopen(produced.id)).status).toBe(200);
    expect((await reopen(byHand.id)).status).toBe(200);

    expect(await ticketOf(produced.id, cookie)).toMatchObject({ statusId: implement, verification: null });
    expect(await ticketOf(byHand.id, cookie)).toMatchObject({ statusId: statusNamed(project, "Done"), verification: null });
    // Back in the producing Step's Status, the delegated Ticket gets a new Run there.
    const runs = await (await cronk.request("GET", `/api/tickets/${produced.id}/runs`, { cookie })).json();
    expect(runs.map((r: { state: string }) => r.state)).toEqual(["stopped", "running"]);
  });

  test("with Pull Request automation turned off, a merge completes nothing and only updates the Pull Request's state", async () => {
    const { workspace, cookie, app, installation, project, cronker } = await projectWithRepository();
    const bea = await beaJoins(workspace.id, cookie);
    expect(project.pullRequestAutomation).toBe(true);
    const ticket = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Left alone" });
    const turnedOff = await cronk.request("PATCH", `/api/projects/${project.id}`, { cookie, body: { pullRequestAutomation: false } });
    expect(turnedOff.status).toBe(200);
    expect(await turnedOff.json()).toMatchObject({ pullRequestAutomation: false });
    const pr = { id: 501, number: 7, title: "CRONK-1", branch: "b" };
    await deliver(app, "pull_request", pullRequestEvent("opened", installation, cronker, pr));

    await deliver(app, "pull_request", pullRequestEvent("closed", installation, cronker, merged(pr, { login: "bea", id: bea.account.id })));

    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: ticket.statusId, verification: null });
    expect(await pullRequestsOf(ticket.id, cookie)).toMatchObject([{ id: 501, state: "merged", mergedBy: "bea" }]);
  });

  test("only the delivery of the merge completes: a later delivery about the merged Pull Request leaves a reopened Ticket alone", async () => {
    const { cookie, app, installation, project, cronker } = await projectWithRepository();
    const ticket = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Reopened" });
    const pr = { id: 501, number: 7, title: "CRONK-1", branch: "b" };
    await deliver(app, "pull_request", pullRequestEvent("closed", installation, cronker, merged(pr, { login: "mallory", id: 666 })));
    const reopened = await cronk.request("POST", `/api/tickets/${ticket.id}/reopen`, { cookie, body: { comment: "Not done." } });
    expect(reopened.status).toBe(200);
    const implement = statusNamed(project, "Implement");
    await cronk.request("PATCH", `/api/tickets/${ticket.id}`, { cookie, body: { statusId: implement } });

    await deliver(
      app,
      "pull_request",
      pullRequestEvent("edited", installation, cronker, merged(pr, { login: "mallory", id: 666 }, { title: "CRONK-1 renamed", updatedAt: "2026-01-01T13:00:00Z" })),
    );

    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: implement, verification: null });
  });
});

