import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addMember, createGitHubApp, setUp, signIn } from "../harness/flows.js";
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
