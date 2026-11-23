import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { hours } from "../harness/clock.js";
import { addMember, createGitHubApp, linkGitHub, setUp, signIn, signInWithGitHub } from "../harness/flows.js";
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

/** A `check_run` delivery as GitHub sends it, with only the fields Cronk reads. */
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
/** A `check_suite` delivery as GitHub sends it, with only the fields Cronk reads. */
const checkSuiteEvent = (
  installation: StandInInstallation,
  repository: StandInRepository,
  suite: { id: number; app: string; sha: string; conclusion: string | null; updatedAt?: string; action?: string },
) => ({
  action: suite.action ?? "completed",
  installation: { id: installation.id },
  repository: { id: repository.id, full_name: repository.fullName, html_url: `https://github.com/${repository.fullName}` },
  check_suite: {
    id: suite.id,
    head_sha: suite.sha,
    status: suite.conclusion === null ? "queued" : "completed",
    conclusion: suite.conclusion,
    app: { name: suite.app },
    updated_at: suite.updatedAt ?? "2026-01-01T09:30:00Z",
  },
});
/** A `status` delivery as GitHub sends it, with only the fields Cronk reads. */
const statusEvent = (
  installation: StandInInstallation,
  repository: StandInRepository,
  status: { id: number; context: string; sha: string; state: string; targetUrl?: string },
) => ({
  installation: { id: installation.id },
  repository: { id: repository.id, full_name: repository.fullName },
  id: status.id,
  sha: status.sha,
  context: status.context,
  state: status.state,
  target_url: status.targetUrl ?? null,
});

/** A `pull_request_review` delivery as GitHub sends it, with only the fields Cronk reads. */
const reviewEvent = (
  installation: StandInInstallation,
  repository: StandInRepository,
  pr: PullRequestFields,
  review: { id: number; state: string; reviewer: string },
  action = "submitted",
) => ({
  action,
  installation: { id: installation.id },
  repository: { id: repository.id, full_name: repository.fullName },
  review: {
    id: review.id,
    state: review.state,
    user: { login: review.reviewer, id: 4000 + review.id },
    html_url: `https://github.com/${repository.fullName}/pull/${pr.number}#pullrequestreview-${review.id}`,
  },
  pull_request: pullRequestEvent(action, installation, repository, pr).pull_request,
});

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
      reviewState: null,
      sentBack: null,
      conflict: null,
      manual: false,
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

describe("A Pull Request's review state", () => {
  test("an approval shows, on a Pull Request no Run opened, whatever the Ticket's Status", async () => {
    const { cookie, app, installation, project, cronker } = await projectWithRepository();
    const ticket = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Ada's own" });
    const pr = { id: 501, number: 7, title: "CRONK-1", branch: "b" };
    await deliver(app, "pull_request", pullRequestEvent("opened", installation, cronker, pr));
    expect((await pullRequestsOf(ticket.id, cookie))[0].reviewState).toBeNull();

    await deliver(app, "pull_request_review", reviewEvent(installation, cronker, pr, { id: 70, state: "approved", reviewer: "bea" }));

    expect((await pullRequestsOf(ticket.id, cookie))[0].reviewState).toEqual({
      state: "approved",
      reviewer: "bea",
      url: "https://github.com/cronkcorp/cronker/pull/7#pullrequestreview-70",
    });
  });

  test("each reviewer's latest review wins, a late delivery changes nothing, and a review that only comments leaves it", async () => {
    const { cookie, app, installation, project, cronker } = await projectWithRepository();
    const ticket = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Reviewed twice" });
    const pr = { id: 501, number: 7, title: "CRONK-1", branch: "b" };
    await deliver(app, "pull_request", pullRequestEvent("opened", installation, cronker, pr));
    const reviewStateAfter = async (review: { id: number; state: string; reviewer: string }) => {
      await deliver(app, "pull_request_review", reviewEvent(installation, cronker, pr, review));
      const state = (await pullRequestsOf(ticket.id, cookie))[0].reviewState;
      return state && `${state.state} by ${state.reviewer}`;
    };

    expect(await reviewStateAfter({ id: 70, state: "approved", reviewer: "bea" })).toBe("approved by bea");
    expect(await reviewStateAfter({ id: 72, state: "changes_requested", reviewer: "bea" })).toBe("changes_requested by bea");
    expect(await reviewStateAfter({ id: 71, state: "approved", reviewer: "bea" })).toBe("changes_requested by bea");
    expect(await reviewStateAfter({ id: 73, state: "commented", reviewer: "bea" })).toBe("changes_requested by bea");
    expect(await reviewStateAfter({ id: 74, state: "approved", reviewer: "bea" })).toBe("approved by bea");
    // Of several reviewers, changes one of them still requests outweigh another's approval.
    expect(await reviewStateAfter({ id: 75, state: "changes_requested", reviewer: "cy" })).toBe("changes_requested by cy");
    expect(await reviewStateAfter({ id: 76, state: "approved", reviewer: "dee" })).toBe("changes_requested by cy");
    expect(await reviewStateAfter({ id: 77, state: "approved", reviewer: "cy" })).toBe("approved by cy");
  });

  test("a dismissed review clears it, leaving the other reviewers' reviews", async () => {
    const { cookie, app, installation, project, cronker } = await projectWithRepository();
    const ticket = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Dismissed" });
    const pr = { id: 501, number: 7, title: "CRONK-1", branch: "b" };
    await deliver(app, "pull_request", pullRequestEvent("opened", installation, cronker, pr));
    await deliver(app, "pull_request_review", reviewEvent(installation, cronker, pr, { id: 70, state: "approved", reviewer: "bea" }));
    await deliver(app, "pull_request_review", reviewEvent(installation, cronker, pr, { id: 72, state: "changes_requested", reviewer: "cy" }));

    await deliver(app, "pull_request_review", reviewEvent(installation, cronker, pr, { id: 72, state: "dismissed", reviewer: "cy" }, "dismissed"));
    expect((await pullRequestsOf(ticket.id, cookie))[0].reviewState).toMatchObject({ state: "approved", reviewer: "bea" });

    await deliver(app, "pull_request_review", reviewEvent(installation, cronker, pr, { id: 70, state: "dismissed", reviewer: "bea" }, "dismissed"));
    expect((await pullRequestsOf(ticket.id, cookie))[0].reviewState).toBeNull();

    // The submission delivered after its dismissal leaves it dismissed.
    await deliver(app, "pull_request_review", reviewEvent(installation, cronker, pr, { id: 70, state: "approved", reviewer: "bea" }));
    expect((await pullRequestsOf(ticket.id, cookie))[0].reviewState).toBeNull();
  });

  test("a review delivered before Cronk hears of its Pull Request shows once it does; one in a Repository no Project lists is not kept", async () => {
    const { cookie, app, installation, project, cronker, website } = await projectWithRepository();
    const ticket = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Early review" });
    const pr = { id: 501, number: 7, title: "CRONK-1", branch: "b" };
    const elsewhere = { id: 502, number: 8, title: "CRONK-1 elsewhere", branch: "b" };

    await deliver(app, "pull_request_review", reviewEvent(installation, cronker, pr, { id: 70, state: "approved", reviewer: "bea" }));
    await deliver(app, "pull_request_review", reviewEvent(installation, website, elsewhere, { id: 71, state: "approved", reviewer: "bea" }));
    expect(await pullRequestsOf(ticket.id, cookie)).toEqual([]);
    await deliver(app, "pull_request", pullRequestEvent("opened", installation, cronker, pr));
    // Listed only now, the other Repository's Pull Request shows without the review delivered before.
    await post(cookie, `/api/projects/${project.id}/repositories`, { id: website.id });
    await deliver(app, "pull_request", pullRequestEvent("opened", installation, website, elsewhere));

    expect((await pullRequestsOf(ticket.id, cookie)).map((p: { number: number; reviewState: unknown }) => [p.number, p.reviewState])).toEqual([
      [7, { state: "approved", reviewer: "bea", url: "https://github.com/cronkcorp/cronker/pull/7#pullrequestreview-70" }],
      [8, null],
    ]);
  });

  test("requested changes show whatever the Ticket's Status, without sending it back, and the Workspace hears of it", async () => {
    const { workspace, cookie, app, installation, project, cronker } = await projectWithRepository();
    const ticket = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "In Backlog" });
    const pr = { id: 501, number: 7, title: "CRONK-1", branch: "b" };
    await deliver(app, "pull_request", pullRequestEvent("opened", installation, cronker, pr));
    const stream = await openStream(cronk, cookie, workspace.id);

    await deliver(app, "pull_request_review", reviewEvent(installation, cronker, pr, { id: 72, state: "changes_requested", reviewer: "bea" }));

    expect(await stream.next()).toEqual({ type: "pull_requests.changed", data: { projectId: project.id, ticketId: ticket.id } });
    // The same review delivered again changes nothing, so nothing is heard.
    await deliver(app, "pull_request_review", reviewEvent(installation, cronker, pr, { id: 72, state: "changes_requested", reviewer: "bea" }));
    await stream.expectQuiet();
    stream.close();
    expect((await pullRequestsOf(ticket.id, cookie))[0]).toMatchObject({
      reviewState: { state: "changes_requested", reviewer: "bea" },
      sentBack: null,
    });
    const after = await (await cronk.request("GET", `/api/tickets/${ticket.id}`, { cookie })).json();
    expect(after.statusId).toBe(ticket.statusId);
  });
});

describe("A Pull Request's checks", () => {
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

  test("is the Step of the Run running when the Pull Request opened, though GitHub's report of it arrives after that Run finished", async () => {
    const { workspace, cookie, app, installation, project, cronker } = await projectWithRepository();
    const runner = await post(cookie, "/api/runners", { name: "Fake", kind: "fake" });
    const agent = await post(cookie, `/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
    await cronk.request("PATCH", `/api/agents/${agent.id}`, { cookie, body: { runnerId: runner.id } });
    const { secret } = await post(cookie, `/api/agents/${agent.id}/tokens`, { name: "cloud", access: "full" });
    const implement = project.statuses.find((s: { name: string }) => s.name === "Implement").id;
    const ticket = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Quick finish" });
    // The Implement Run starts at 09:00, opens its Pull Request at 09:01 and finishes at 09:02.
    await cronk.request("PATCH", `/api/tickets/${ticket.id}`, { cookie, body: { delegateId: agent.id, labels: ["no-review"], statusId: implement } });
    const [run] = await (await cronk.request("GET", `/api/tickets/${ticket.id}/runs`, { cookie })).json();
    cronk.clock.advance(2 * 60_000);
    const finished = await cronk.request("POST", `/api/runs/${run.id}/finish`, { headers: { authorization: `Bearer ${secret}` }, body: { outcome: "done" } });
    expect(finished.status, await finished.clone().text()).toBe(200);
    cronk.clock.advance(60_000);

    const opened = pullRequestEvent("opened", installation, cronker, { id: 501, number: 7, title: "CRONK-1", branch: "b" });
    await deliver(app, "pull_request", { ...opened, pull_request: { ...opened.pull_request, created_at: "2026-01-01T09:01:00Z" } });

    expect((await pullRequestsOf(ticket.id, cookie))[0].producingStep).toEqual({ runId: run.id, statusId: implement, name: "Implement" });
  });

  test("is absent for a Ticket whose only Run started after the Pull Request opened", async () => {
    const { workspace, cookie, app, installation, project, cronker } = await projectWithRepository();
    const runner = await post(cookie, "/api/runners", { name: "Fake", kind: "fake" });
    const agent = await post(cookie, `/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
    await cronk.request("PATCH", `/api/agents/${agent.id}`, { cookie, body: { runnerId: runner.id } });
    const implement = project.statuses.find((s: { name: string }) => s.name === "Implement").id;
    const ticket = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Opened by hand" });
    cronk.clock.advance(60_000);
    await cronk.request("PATCH", `/api/tickets/${ticket.id}`, { cookie, body: { delegateId: agent.id, statusId: implement } });

    // A User opened it at 09:00, before the Run started at 09:01; GitHub's report arrives while the Run is running.
    const opened = pullRequestEvent("opened", installation, cronker, { id: 501, number: 7, title: "CRONK-1", branch: "b" });
    await deliver(app, "pull_request", { ...opened, pull_request: { ...opened.pull_request, created_at: "2026-01-01T09:00:00Z" } });

    expect((await pullRequestsOf(ticket.id, cookie))[0].producingStep).toBeNull();
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

  test("a merge by the GitHub account a password User linked from their settings page completes the Ticket as Verified", async () => {
    const { workspace, cookie, app, installation, project, cronker } = await projectWithRepository();
    const bea = await addMember(cronk, cookie, workspace.id, "bea@example.com");
    const account = cronk.github.account("bea-gh");
    expect((await linkGitHub(cronk, bea.cookie, account)).location).toBe("/account?github=linked");
    const ticket = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Merge me" });
    const pr = { id: 501, number: 7, title: "CRONK-1", branch: "b" };
    await deliver(app, "pull_request", pullRequestEvent("opened", installation, cronker, pr));

    await deliver(app, "pull_request", pullRequestEvent("closed", installation, cronker, merged(pr, { login: "bea-gh", id: account.id })));

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

  test("a merge by a User of the Workspace while a Run is running counts as its Agent's, in that Run, completing the Ticket as Unverified", async () => {
    const { workspace, cookie, app, installation, project, cronker } = await projectWithRepository();
    const bea = await beaJoins(workspace.id, cookie);
    const ada = (await (await cronk.request("GET", "/api/me", { cookie })).json()).user;
    const runner = await post(cookie, "/api/runners", { name: "Fake", kind: "fake" });
    const agent = await post(cookie, `/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
    await cronk.request("PATCH", `/api/agents/${agent.id}`, { cookie, body: { runnerId: runner.id } });
    const ticket = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Being implemented" });
    await cronk.request("PATCH", `/api/tickets/${ticket.id}`, {
      cookie,
      body: { assigneeId: ada.id, delegateId: agent.id, statusId: statusNamed(project, "Implement") },
    });
    const pr = { id: 501, number: 7, title: "CRONK-1: make it so", branch: "b" };
    await deliver(app, "pull_request", pullRequestEvent("opened", installation, cronker, pr));

    // The session merges with Bea's own GitHub credentials.
    await deliver(app, "pull_request", pullRequestEvent("closed", installation, cronker, merged(pr, { login: "bea", id: bea.account.id })));

    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: statusNamed(project, "Done"), verification: "unverified" });
    const inbox = await (await cronk.request("GET", `/api/workspaces/${workspace.id}/inbox`, { cookie })).json();
    expect(inbox.items.filter((i: { kind: string }) => i.kind === "unverified")).toEqual([
      expect.objectContaining({
        ticket: expect.objectContaining({ key: "CRONK-1" }),
        completedBy: { id: statusNamed(project, "Implement"), name: "Implement" },
      }),
    ]);
    const [run] = await (await cronk.request("GET", `/api/tickets/${ticket.id}/runs`, { cookie })).json();
    expect(run).toMatchObject({ state: "stopped", endReason: "@bea merged cronkcorp/cronker#7, completing CRONK-1." });
    expect(cronk.runner.stops.map((s) => s.runId)).toEqual([run.id]);
    const changes = await (await cronk.request("GET", `/api/tickets/${ticket.id}/timeline`, { cookie })).json();
    expect(
      changes.slice(-3).map((c: { actor: unknown; field: string; from: unknown; to: unknown; runId: string | null }) => [
        c.actor,
        c.runId,
        c.field,
        c.from,
        c.to,
      ]),
    ).toEqual([
      [
        expect.objectContaining({ kind: "agent", id: agent.id, name: "claude-max" }),
        run.id,
        "merged",
        null,
        {
          pullRequest: { id: 501, repository: "cronkcorp/cronker", number: 7, title: "CRONK-1: make it so", url: "https://github.com/cronkcorp/cronker/pull/7" },
          mergedBy: "bea",
        },
      ],
      [
        expect.objectContaining({ kind: "agent", id: agent.id }),
        run.id,
        "status",
        { id: statusNamed(project, "Implement"), name: "Implement" },
        { id: statusNamed(project, "Done"), name: "Done" },
      ],
      [expect.objectContaining({ kind: "agent", id: agent.id }), run.id, "verification", null, "unverified"],
    ]);
  });

  test("a merge by a User of the Workspace after the Ticket's Run ended completes it as Verified, as the User's", async () => {
    const { workspace, cookie, app, installation, project, cronker } = await projectWithRepository();
    const bea = await beaJoins(workspace.id, cookie);
    const runner = await post(cookie, "/api/runners", { name: "Fake", kind: "fake" });
    const agent = await post(cookie, `/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
    await cronk.request("PATCH", `/api/agents/${agent.id}`, { cookie, body: { runnerId: runner.id } });
    const ticket = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Implemented" });
    await cronk.request("PATCH", `/api/tickets/${ticket.id}`, { cookie, body: { delegateId: agent.id, statusId: statusNamed(project, "Implement") } });
    const pr = { id: 501, number: 7, title: "CRONK-1: make it so", branch: "b" };
    await deliver(app, "pull_request", pullRequestEvent("opened", installation, cronker, pr));
    // The User takes the Ticket back to In Review, stopping the Run, then merges.
    await cronk.request("PATCH", `/api/tickets/${ticket.id}`, { cookie, body: { statusId: statusNamed(project, "In Review") } });

    await deliver(app, "pull_request", pullRequestEvent("closed", installation, cronker, merged(pr, { login: "bea", id: bea.account.id })));

    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: statusNamed(project, "Done"), verification: "verified" });
    const changes = await (await cronk.request("GET", `/api/tickets/${ticket.id}/timeline`, { cookie })).json();
    expect(changes.slice(-3).map((c: { actor: { kind: string }; runId: string | null; field: string }) => [c.actor.kind, c.runId, c.field])).toEqual([
      ["cronk", null, "merged"],
      ["cronk", null, "status"],
      ["cronk", null, "verification"],
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

  test("a merge completes nothing in a Project that removed the Repository since, though its Pull Request still shows there", async () => {
    const { workspace, cookie, app, installation, project, cronker } = await projectWithRepository();
    // Another Project keeps listing the Repository, so Cronk still hears of its Pull Requests.
    const website = await post(cookie, `/api/workspaces/${workspace.id}/projects`, { name: "Website", key: "WEB" });
    await post(cookie, `/api/projects/${website.id}/repositories`, { id: cronker.id });
    const ticket = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Left behind" });
    const pr = { id: 501, number: 7, title: "CRONK-1", branch: "b" };
    await deliver(app, "pull_request", pullRequestEvent("opened", installation, cronker, pr));
    const removed = await cronk.request("DELETE", `/api/projects/${project.id}/repositories/${cronker.id}`, { cookie });
    expect(removed.status).toBe(204);

    await deliver(app, "pull_request", pullRequestEvent("closed", installation, cronker, merged(pr, { login: "mallory", id: 666 })));

    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: ticket.statusId, verification: null });
    expect(await pullRequestsOf(ticket.id, cookie)).toMatchObject([{ id: 501, state: "merged" }]);
  });

  test("a merge completes nothing in an archived Project, though its Pull Request still shows there, merged", async () => {
    const { workspace, cookie, app, installation, project, cronker } = await projectWithRepository();
    const bea = await beaJoins(workspace.id, cookie);
    const ticket = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Archived away" });
    const pr = { id: 501, number: 7, title: "CRONK-1", branch: "b" };
    await deliver(app, "pull_request", pullRequestEvent("opened", installation, cronker, pr));
    expect((await cronk.request("POST", `/api/projects/${project.id}/archive`, { cookie })).status).toBe(200);

    await deliver(app, "pull_request", pullRequestEvent("closed", installation, cronker, merged(pr, { login: "bea", id: bea.account.id })));

    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: ticket.statusId, verification: null });
    expect(await pullRequestsOf(ticket.id, cookie)).toMatchObject([{ id: 501, state: "merged", mergedBy: "bea" }]);
  });

  test("a Repository shared with an archived Project still has its merges complete the other Project's Tickets", async () => {
    const { workspace, cookie, app, installation, project, cronker } = await projectWithRepository();
    const bea = await beaJoins(workspace.id, cookie);
    const website = await post(cookie, `/api/workspaces/${workspace.id}/projects`, { name: "Website", key: "WEB" });
    await post(cookie, `/api/projects/${website.id}/repositories`, { id: cronker.id });
    const archived = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Archived away" });
    const active = await post(cookie, `/api/projects/${website.id}/tickets`, { title: "Still going" });
    const pr = { id: 501, number: 7, title: "CRONK-1 and WEB-1", branch: "b" };
    await deliver(app, "pull_request", pullRequestEvent("opened", installation, cronker, pr));
    expect((await cronk.request("POST", `/api/projects/${project.id}/archive`, { cookie })).status).toBe(200);

    await deliver(app, "pull_request", pullRequestEvent("closed", installation, cronker, merged(pr, { login: "bea", id: bea.account.id })));

    expect(await ticketOf(archived.id, cookie)).toMatchObject({ statusId: archived.statusId, verification: null });
    expect(await ticketOf(active.id, cookie)).toMatchObject({ statusId: statusNamed(website, "Done"), verification: "verified" });
    for (const ticket of [archived, active]) {
      expect(await pullRequestsOf(ticket.id, cookie)).toMatchObject([{ id: 501, state: "merged" }]);
    }
  });

  test("one merge completes a Ticket as Verified in the merger's Workspace and as Unverified in another, each Change naming the merger", async () => {
    const { workspace, cookie, app, installation, project, cronker } = await projectWithRepository();
    const bea = await beaJoins(workspace.id, cookie);
    const ours = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Ours" });
    // Ada's second Workspace, which Bea isn't in, has a Project of the same key on the Repository.
    const other = await post(cookie, "/api/workspaces", { name: "Side project" });
    const theirProject = await post(cookie, `/api/workspaces/${other.id}/projects`, { name: "Side", key: "CRONK" });
    await post(cookie, `/api/projects/${theirProject.id}/repositories`, { id: cronker.id });
    const theirs = await post(cookie, `/api/projects/${theirProject.id}/tickets`, { title: "Theirs" });
    const pr = { id: 501, number: 7, title: "CRONK-1", branch: "b" };

    await deliver(app, "pull_request", pullRequestEvent("closed", installation, cronker, merged(pr, { login: "bea", id: bea.account.id })));

    expect(await ticketOf(ours.id, cookie)).toMatchObject({ statusId: statusNamed(project, "Done"), verification: "verified" });
    expect(await ticketOf(theirs.id, cookie)).toMatchObject({ statusId: statusNamed(theirProject, "Done"), verification: "unverified" });
    for (const ticket of [ours, theirs]) {
      const timeline = await (await cronk.request("GET", `/api/tickets/${ticket.id}/timeline`, { cookie })).json();
      expect(timeline.find((c: { field?: string }) => c.field === "merged")).toMatchObject({
        actor: { kind: "cronk" },
        to: { pullRequest: { repository: "cronkcorp/cronker", number: 7 }, mergedBy: "bea" },
      });
    }
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


describe("Failures sending work back", () => {
  const statusNamed = (project: { statuses: { id: string; name: string }[] }, name: string) =>
    project.statuses.find((s) => s.name === name)!.id;
  const ok = async (method: string, path: string, cookie: string, body?: unknown) => {
    const response = await cronk.request(method, path, { cookie, body });
    expect(response.status, await response.clone().text()).toBeLessThan(300);
    return response.json();
  };

  /**
   * A delegated Ticket whose Implement Run, still running in that Active Status, opened Pull Request 501 (`CRONK-1`,
   * branch `b`, latest commit `c1`). Finishing it with *done* moves it, past Code review that its `no-review` Label
   * skips, to In Review, a Review Status.
   */
  async function implementing() {
    const setup = await projectWithRepository();
    const { workspace, cookie, app, installation, project, cronker } = setup;
    const runner = await post(cookie, "/api/runners", { name: "Fake", kind: "fake" });
    const agent = await post(cookie, `/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
    await ok("PATCH", `/api/agents/${agent.id}`, cookie, { runnerId: runner.id });
    const { secret } = await post(cookie, `/api/agents/${agent.id}/tokens`, { name: "cloud", access: "full" });
    const ticket = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Make it so" });
    await ok("PATCH", `/api/tickets/${ticket.id}`, cookie, {
      delegateId: agent.id,
      labels: ["no-review"],
      statusId: statusNamed(project, "Implement"),
    });
    const pr = { id: 501, number: 7, title: "CRONK-1: make it so", branch: "b", sha: "c1" };
    await deliver(app, "pull_request", pullRequestEvent("opened", installation, cronker, pr));
    /** The Agent finishes the Run running on the Ticket with *done*. */
    const finishImplementing = async () => {
      const running = (await ok("GET", `/api/tickets/${ticket.id}/runs`, cookie)).find((r: { state: string }) => r.state === "running");
      const finished = await cronk.request("POST", `/api/runs/${running.id}/finish`, {
        headers: { authorization: `Bearer ${secret}` },
        body: { outcome: "done" },
      });
      expect(finished.status, await finished.clone().text()).toBe(200);
    };
    const status = (name: string) => statusNamed(project, name);
    return { ...setup, ticket, pr, status, secret, finishImplementing };
  }

  /** The Ticket of `implementing`, its Implement Run finished with *done*, moving it to In Review. */
  async function inReview() {
    const implemented = await implementing();
    await implemented.finishImplementing();
    expect(await ticketOf(implemented.ticket.id, implemented.cookie)).toMatchObject({ statusId: implemented.status("In Review") });
    return implemented;
  }

  const ticketOf = async (ticketId: string, cookie: string) => ok("GET", `/api/tickets/${ticketId}`, cookie);
  const commentsOf = async (ticketId: string, cookie: string) => ok("GET", `/api/tickets/${ticketId}/comments`, cookie);

  test("a failed check run on the latest commit sends the Ticket back to the producing Step's Status, with a Comment from Cronk linking it", async () => {
    const { cookie, app, installation, cronker, ticket, status } = await inReview();

    await deliver(app, "check_run", checkRunEvent(installation, cronker, { id: 10, name: "test", sha: "c1", status: "completed", conclusion: "failure" }));

    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("Implement") });
    const comments = await commentsOf(ticket.id, cookie);
    expect(comments).toHaveLength(1);
    expect(comments[0].actor).toEqual({ kind: "cronk", name: "Cronk" });
    expect(comments[0].body).toContain("https://github.com/cronkcorp/cronker/runs/10");
    expect(comments[0]).toMatchObject({ sentBack: true, questionId: null });
    // Back in the producing Step's Status, the delegated Ticket gets a new Run there.
    const runs = await ok("GET", `/api/tickets/${ticket.id}/runs`, cookie);
    expect(runs.map((r: { state: string }) => r.state)).toEqual(["finished", "running"]);
  });

  test("a check suite failing on the latest commit with no failing check run sends the Ticket back, with a Comment from Cronk", async () => {
    const { cookie, app, installation, cronker, ticket, status } = await inReview();

    await deliver(app, "check_suite", checkSuiteEvent(installation, cronker, { id: 30, app: "GitHub Actions", sha: "c1", conclusion: "startup_failure" }));

    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("Implement") });
    const comments = await commentsOf(ticket.id, cookie);
    expect(comments.map((c: { actor: unknown; body: string; sentBack: boolean }) => [c.actor, c.body, c.sentBack])).toEqual([
      [
        { kind: "cronk", name: "Cronk" },
        "The check [**GitHub Actions**](https://github.com/cronkcorp/cronker/commit/c1/checks) failed on " +
          "[cronkcorp/cronker#7](https://github.com/cronkcorp/cronker/pull/7)'s latest commit `c1`. Sent CRONK-1 back to Implement.",
        true,
      ],
    ]);
  });

  test.each([
    ["the check run", "check_run", "The check [**test**](https://github.com/cronkcorp/cronker/runs/10) failed"],
    ["the suite", "check_suite", "The check [**GitHub Actions**](https://github.com/cronkcorp/cronker/commit/c1/checks) failed"],
  ])("a failing check suite and a failing check run on the same commit send the Ticket back once, %s first", async (_, first, comment) => {
    const { cookie, app, installation, cronker, ticket, status, finishImplementing } = await inReview();
    const deliveries = {
      check_run: checkRunEvent(installation, cronker, { id: 10, name: "test", sha: "c1", status: "completed", conclusion: "failure" }),
      check_suite: checkSuiteEvent(installation, cronker, { id: 30, app: "GitHub Actions", sha: "c1", conclusion: "failure" }),
    };
    const second = first === "check_run" ? "check_suite" : "check_run";
    await deliver(app, first, deliveries[first as keyof typeof deliveries]);
    await finishImplementing();

    await deliver(app, second, deliveries[second]);

    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("In Review") });
    expect((await commentsOf(ticket.id, cookie)).map((c: { body: string }) => c.body.split(" on ")[0])).toEqual([comment]);
  });

  test.each(["failure", "timed_out", "cancelled", "startup_failure"])("a check suite concluding %s on the latest commit sends the Ticket back", async (conclusion) => {
    const { cookie, app, installation, cronker, ticket, status } = await inReview();

    await deliver(app, "check_suite", checkSuiteEvent(installation, cronker, { id: 30, app: "GitHub Actions", sha: "c1", conclusion }));

    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("Implement") });
  });

  test("passing, neutral, skipped, stale and action-required check suites, a suite only requested, and a failing suite on an earlier commit send nothing back", async () => {
    const { cookie, app, installation, cronker, ticket, pr, status } = await inReview();
    await deliver(app, "pull_request", pullRequestEvent("synchronize", installation, cronker, { ...pr, sha: "c2", updatedAt: "2026-01-01T10:00:00Z" }));

    for (const [id, conclusion] of [[30, "success"], [31, "neutral"], [32, "skipped"], [33, "action_required"], [34, "stale"]] as const) {
      await deliver(app, "check_suite", checkSuiteEvent(installation, cronker, { id, app: `App ${id}`, sha: "c2", conclusion }));
    }
    await deliver(app, "check_suite", {
      ...checkSuiteEvent(installation, cronker, { id: 35, app: "GitHub Actions", sha: "c2", conclusion: "failure" }),
      action: "requested",
    });
    // The commit before the latest.
    await deliver(app, "check_suite", checkSuiteEvent(installation, cronker, { id: 36, app: "GitHub Actions", sha: "c1", conclusion: "failure" }));

    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("In Review") });
    expect(await commentsOf(ticket.id, cookie)).toEqual([]);
    // Suites aren't among the Pull Request's checks.
    expect((await pullRequestsOf(ticket.id, cookie))[0].checks).toEqual([]);
  });

  test("a check suite failing on a new commit before GitHub reports the push sends the Ticket back once the push is reported, unless a rerun passed", async () => {
    const { cookie, app, installation, cronker, ticket, pr, status } = await inReview();
    await deliver(app, "check_suite", checkSuiteEvent(installation, cronker, { id: 30, app: "Lint", sha: "c2", conclusion: "failure" }));
    // Rerun, the same suite completes again; a late delivery of the earlier completion changes nothing.
    const rerun = checkSuiteEvent(installation, cronker, { id: 30, app: "Lint", sha: "c2", conclusion: "success", updatedAt: "2026-01-01T09:40:00Z" });
    await deliver(app, "check_suite", rerun);
    await deliver(app, "check_suite", checkSuiteEvent(installation, cronker, { id: 30, app: "Lint", sha: "c2", conclusion: "failure" }));
    await deliver(app, "check_suite", checkSuiteEvent(installation, cronker, { id: 31, app: "GitHub Actions", sha: "c2", conclusion: "startup_failure" }));
    // Another failed suite is being rerun when the push is reported, so it no longer counts.
    await deliver(app, "check_suite", checkSuiteEvent(installation, cronker, { id: 29, app: "Build", sha: "c2", conclusion: "failure" }));
    await deliver(app, "check_suite", checkSuiteEvent(installation, cronker, {
      id: 29, app: "Build", sha: "c2", conclusion: null, action: "rerequested", updatedAt: "2026-01-01T09:45:00Z",
    }));
    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("In Review") });

    await deliver(app, "pull_request", pullRequestEvent("synchronize", installation, cronker, { ...pr, sha: "c2", updatedAt: "2026-01-01T10:00:00Z" }));

    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("Implement") });
    expect((await commentsOf(ticket.id, cookie)).map((c: { body: string }) => c.body.split(" on ")[0])).toEqual([
      "The check [**GitHub Actions**](https://github.com/cronkcorp/cronker/commit/c2/checks) failed",
    ]);
  });

  test("a failing check's send-back records a Change by Cronk naming the Pull Request and the check, just before its move", async () => {
    const { cookie, app, installation, cronker, ticket } = await inReview();

    await deliver(app, "check_run", checkRunEvent(installation, cronker, { id: 10, name: "test", sha: "c1", status: "completed", conclusion: "failure" }));

    const timeline = await ok("GET", `/api/tickets/${ticket.id}/timeline`, cookie);
    const at = timeline.findIndex((c: { field: string }) => c.field === "sentBack");
    expect(timeline[at]).toMatchObject({
      actor: { kind: "cronk", name: "Cronk" },
      from: null,
      to: {
        pullRequest: { id: 501, repository: "cronkcorp/cronker", number: 7, url: "https://github.com/cronkcorp/cronker/pull/7" },
        failure: { kind: "check", name: "test", url: "https://github.com/cronkcorp/cronker/runs/10" },
      },
      runId: null,
    });
    expect(timeline[at + 1]).toMatchObject({
      actor: { kind: "cronk" },
      field: "status",
      from: { name: "In Review" },
      to: { name: "Implement" },
      at: timeline[at].at,
    });
  });

  test("each send-back from the same Pull Request records its own Change, requested changes naming the review", async () => {
    const { cookie, app, installation, cronker, ticket, pr, finishImplementing } = await inReview();
    await deliver(app, "check_run", checkRunEvent(installation, cronker, { id: 10, name: "test", sha: "c1", status: "completed", conclusion: "failure" }));
    await finishImplementing();

    await deliver(app, "pull_request_review", reviewEvent(installation, cronker, pr, { id: 72, state: "changes_requested", reviewer: "bea" }));

    const timeline = await ok("GET", `/api/tickets/${ticket.id}/timeline`, cookie);
    const pullRequest = { id: 501, repository: "cronkcorp/cronker", number: 7, url: "https://github.com/cronkcorp/cronker/pull/7" };
    expect(timeline.filter((c: { field: string }) => c.field === "sentBack").map((c: { to: unknown }) => c.to)).toEqual([
      { pullRequest, failure: { kind: "check", name: "test", url: "https://github.com/cronkcorp/cronker/runs/10" } },
      { pullRequest, failure: { kind: "review", reviewer: "bea", url: "https://github.com/cronkcorp/cronker/pull/7#pullrequestreview-72" } },
    ]);
  });

  test.each<[string, string, { conclusion?: string; state?: string }]>([
    ["a check run that failed", "check_run", { conclusion: "failure" }],
    ["a check run that timed out", "check_run", { conclusion: "timed_out" }],
    ["a check run that was cancelled", "check_run", { conclusion: "cancelled" }],
    ["a commit status that failed", "status", { state: "failure" }],
    ["a commit status that errored", "status", { state: "error" }],
  ])("%s on the latest commit sends the Ticket back", async (_, event, ended) => {
    const { cookie, app, installation, cronker, ticket, status } = await inReview();

    await deliver(
      app,
      event,
      event === "check_run"
        ? checkRunEvent(installation, cronker, { id: 10, name: "test", sha: "c1", status: "completed", conclusion: ended.conclusion })
        : statusEvent(installation, cronker, { id: 20, context: "ci/build", sha: "c1", state: ended.state!, targetUrl: "https://ci.example/20" }),
    );

    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("Implement") });
  });

  test("passing, neutral, skipped and pending checks, and a failure on an earlier commit, send nothing back", async () => {
    const { cookie, app, installation, cronker, ticket, pr, status } = await inReview();
    await deliver(app, "pull_request", pullRequestEvent("synchronize", installation, cronker, { ...pr, sha: "c2", updatedAt: "2026-01-01T10:00:00Z" }));

    for (const [id, conclusion] of [[10, "success"], [11, "neutral"], [12, "skipped"], [13, "action_required"], [14, "stale"]] as const) {
      await deliver(app, "check_run", checkRunEvent(installation, cronker, { id, name: `check ${id}`, sha: "c2", status: "completed", conclusion }));
    }
    await deliver(app, "check_run", checkRunEvent(installation, cronker, { id: 15, name: "slow", sha: "c2", status: "in_progress" }));
    await deliver(app, "status", statusEvent(installation, cronker, { id: 20, context: "ci/build", sha: "c2", state: "success" }));
    await deliver(app, "status", statusEvent(installation, cronker, { id: 21, context: "ci/deploy", sha: "c2", state: "pending" }));
    // The commit before the latest.
    await deliver(app, "check_run", checkRunEvent(installation, cronker, { id: 16, name: "test", sha: "c1", status: "completed", conclusion: "failure" }));

    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("In Review") });
    expect(await commentsOf(ticket.id, cookie)).toEqual([]);
  });

  test("a review requesting changes, whoever wrote it, sends the Ticket back with a Comment linking the review; other reviews don't", async () => {
    const { cookie, app, installation, cronker, ticket, pr, status } = await inReview();

    await deliver(app, "pull_request_review", reviewEvent(installation, cronker, pr, { id: 70, state: "approved", reviewer: "bea" }));
    await deliver(app, "pull_request_review", reviewEvent(installation, cronker, pr, { id: 71, state: "commented", reviewer: "bea" }));
    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("In Review") });

    // An outsider, not a User of the Workspace.
    await deliver(app, "pull_request_review", reviewEvent(installation, cronker, pr, { id: 72, state: "changes_requested", reviewer: "mallory" }));

    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("Implement") });
    const comments = await commentsOf(ticket.id, cookie);
    expect(comments.map((c: { actor: unknown; body: string }) => [c.actor, c.body])).toEqual([
      [
        { kind: "cronk", name: "Cronk" },
        "@mallory [requested changes](https://github.com/cronkcorp/cronker/pull/7#pullrequestreview-72) on " +
          "[cronkcorp/cronker#7](https://github.com/cronkcorp/cronker/pull/7). Sent CRONK-1 back to Implement.",
      ],
    ]);
    expect(comments[0].sentBack).toBe(true);
  });

  test("sending back counts as a round for the producing Step; past its round limit *needs you* applies, with Cronk's Question in the Inbox", async () => {
    const { workspace, project, cookie, app, installation, cronker, ticket, pr, status, finishImplementing } = await inReview();
    const { step } = project.statuses.find((s: { name: string }) => s.name === "Implement");
    await ok("PUT", `/api/projects/${project.id}/statuses/${status("Implement")}/step`, cookie, { ...step, roundLimit: 1 });

    await deliver(app, "check_run", checkRunEvent(installation, cronker, { id: 10, name: "test", sha: "c1", status: "completed", conclusion: "failure" }));
    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("Implement") });
    // The next round pushes a new commit and comes back for review.
    await deliver(app, "pull_request", pullRequestEvent("synchronize", installation, cronker, { ...pr, sha: "c2", updatedAt: "2026-01-01T10:00:00Z" }));
    await finishImplementing();

    await deliver(app, "check_run", checkRunEvent(installation, cronker, { id: 11, name: "test", sha: "c2", status: "completed", conclusion: "failure" }));

    // Implement's *needs you* Outcome moves it to Ready.
    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("Ready") });
    const { items } = await ok("GET", `/api/workspaces/${workspace.id}/inbox`, cookie);
    expect(items.filter((i: { kind: string }) => i.kind === "needsYou")).toEqual([
      expect.objectContaining({
        ticket: expect.objectContaining({ key: "CRONK-1" }),
        status: { id: status("Ready"), name: "Ready" },
        outcome: "needs you",
        step: { statusId: status("Implement"), name: "Implement" },
        question:
          "Failing checks and requested changes sent CRONK-1 back to Implement once, its round limit, so it comes to you " +
          "instead. Read the latest Comments, then move it on yourself.",
      }),
    ]);
    const comments = await commentsOf(ticket.id, cookie);
    expect(comments.map((c: { body: string }) => c.body)).toEqual([
      "The check [**test**](https://github.com/cronkcorp/cronker/runs/10) failed on " +
        "[cronkcorp/cronker#7](https://github.com/cronkcorp/cronker/pull/7)'s latest commit `c1`. Sent CRONK-1 back to Implement.",
      "The check [**test**](https://github.com/cronkcorp/cronker/runs/11) failed on " +
        "[cronkcorp/cronker#7](https://github.com/cronkcorp/cronker/pull/7)'s latest commit `c2`. " +
        "That is past Implement's round limit, so CRONK-1 comes to its Assignee instead.",
    ]);
  });

  test("many failing checks on one commit send the Ticket back once, and so does a review delivered again", async () => {
    const { cookie, app, installation, cronker, ticket, pr, status, finishImplementing } = await inReview();
    for (let id = 10; id < 13; id++) {
      await deliver(app, "check_run", checkRunEvent(installation, cronker, { id, name: `check ${id}`, sha: "c1", status: "completed", conclusion: "failure" }));
    }
    // The next round comes back for review without pushing; more of the same commit's checks fail.
    await finishImplementing();
    await deliver(app, "check_run", checkRunEvent(installation, cronker, { id: 13, name: "check 13", sha: "c1", status: "completed", conclusion: "failure" }));
    await deliver(app, "status", statusEvent(installation, cronker, { id: 20, context: "ci/build", sha: "c1", state: "failure" }));
    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("In Review") });

    const review = reviewEvent(installation, cronker, pr, { id: 72, state: "changes_requested", reviewer: "bea" });
    await deliver(app, "pull_request_review", review);
    await finishImplementing();
    // GitHub sends the same review again under a new delivery id.
    await deliver(app, "pull_request_review", review);

    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("In Review") });
    const comments = await commentsOf(ticket.id, cookie);
    expect(comments.map((c: { body: string }) => c.body.split(" on ")[0])).toEqual([
      "The check [**check 10**](https://github.com/cronkcorp/cronker/runs/10) failed",
      "@bea [requested changes](https://github.com/cronkcorp/cronker/pull/7#pullrequestreview-72)",
    ]);
  });

  test("a check that failed on the latest commit while the Ticket was in an Active Status sends it back once an Outcome moves it into a Review Status", async () => {
    const { cookie, app, installation, cronker, ticket, status, finishImplementing } = await implementing();
    await deliver(app, "check_run", checkRunEvent(installation, cronker, { id: 10, name: "test", sha: "c1", status: "completed", conclusion: "failure" }));
    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("Implement") });
    expect(await commentsOf(ticket.id, cookie)).toEqual([]);

    await finishImplementing();

    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("Implement") });
    expect((await commentsOf(ticket.id, cookie)).map((c: { actor: unknown; body: string; sentBack: boolean }) => [c.actor, c.body, c.sentBack])).toEqual([
      [
        { kind: "cronk", name: "Cronk" },
        "The check [**test**](https://github.com/cronkcorp/cronker/runs/10) failed on " +
          "[cronkcorp/cronker#7](https://github.com/cronkcorp/cronker/pull/7)'s latest commit `c1`. Sent CRONK-1 back to Implement.",
        true,
      ],
    ]);
    // Back in Implement, the delegated Ticket gets a new Run there.
    const runs = await ok("GET", `/api/tickets/${ticket.id}/runs`, cookie);
    expect(runs.map((r: { state: string }) => r.state)).toEqual(["finished", "running"]);

    // The same failure already sent it back: the next Outcome into In Review leaves it there.
    await finishImplementing();
    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("In Review") });
    expect(await commentsOf(ticket.id, cookie)).toHaveLength(1);
  });

  test("requested changes submitted while the Ticket was in an Active Status send it back once an Outcome moves it into a Review Status", async () => {
    const { cookie, app, installation, cronker, ticket, pr, status, finishImplementing } = await implementing();
    await deliver(app, "pull_request_review", reviewEvent(installation, cronker, pr, { id: 72, state: "changes_requested", reviewer: "bea" }));
    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("Implement") });
    expect(await commentsOf(ticket.id, cookie)).toEqual([]);

    await finishImplementing();

    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("Implement") });
    expect((await commentsOf(ticket.id, cookie)).map((c: { actor: unknown; body: string; sentBack: boolean }) => [c.actor, c.body, c.sentBack])).toEqual([
      [
        { kind: "cronk", name: "Cronk" },
        "@bea [requested changes](https://github.com/cronkcorp/cronker/pull/7#pullrequestreview-72) on " +
          "[cronkcorp/cronker#7](https://github.com/cronkcorp/cronker/pull/7). Sent CRONK-1 back to Implement.",
        true,
      ],
    ]);

    // The review still requests changes, but it already sent the Ticket back: the next Outcome leaves it in In Review.
    await finishImplementing();
    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("In Review") });
    expect(await commentsOf(ticket.id, cookie)).toHaveLength(1);
  });

  test("a check that failed while the Code review Run was working sends the Ticket back once that Run approves, and the Workspace hears of it", async () => {
    const { workspace, cookie, app, installation, project, cronker, ticket, status, secret, finishImplementing } = await implementing();
    await ok("PATCH", `/api/tickets/${ticket.id}`, cookie, { labels: [] });
    // Implement's *done* moves it to Code review, an Active Status, whose Run starts working.
    await finishImplementing();
    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("Code review") });
    await deliver(app, "check_run", checkRunEvent(installation, cronker, { id: 10, name: "test", sha: "c1", status: "completed", conclusion: "failure" }));
    const running = (await ok("GET", `/api/tickets/${ticket.id}/runs`, cookie)).find((r: { state: string }) => r.state === "running");
    const stream = await openStream(cronk, cookie, workspace.id);

    const approved = await cronk.request("POST", `/api/runs/${running.id}/finish`, {
      headers: { authorization: `Bearer ${secret}` },
      body: { outcome: "approve" },
    });
    expect(approved.status, await approved.clone().text()).toBe(200);

    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("Implement") });
    expect((await commentsOf(ticket.id, cookie)).map((c: { body: string }) => c.body)).toEqual([
      "The check [**test**](https://github.com/cronkcorp/cronker/runs/10) failed on " +
        "[cronkcorp/cronker#7](https://github.com/cronkcorp/cronker/pull/7)'s latest commit `c1`. Sent CRONK-1 back to Implement.",
    ]);
    const heard: unknown[] = [];
    for (;;) {
      try {
        heard.push(await stream.next(300));
      } catch {
        break;
      }
    }
    stream.close();
    expect(heard).toContainEqual({ type: "pull_requests.changed", data: { projectId: project.id, ticketId: ticket.id } });
  });

  test("a failure known before a skipped Step's default Outcome moves the Ticket into a Review Status sends it back", async () => {
    const { cookie, app, installation, cronker, ticket, status } = await implementing();
    await deliver(app, "check_run", checkRunEvent(installation, cronker, { id: 10, name: "test", sha: "c1", status: "completed", conclusion: "failure" }));

    // Ada moves it to Code review, which its `no-review` Label skips by its default Outcome, into In Review.
    await ok("PATCH", `/api/tickets/${ticket.id}`, cookie, { statusId: status("Code review") });

    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("Implement") });
    expect(await commentsOf(ticket.id, cookie)).toHaveLength(1);
  });

  test("a Step on the Review Status gets no Run when a known failure sends the Ticket straight back", async () => {
    const { cookie, app, installation, project, cronker, ticket, status, finishImplementing } = await implementing();
    await ok("PUT", `/api/projects/${project.id}/statuses/${status("In Review")}/step`, cookie, {
      brief: "Look it over.",
      model: "opus",
      outcomes: [
        { name: "park", statusId: status("Backlog"), default: true, needsYou: false, countsAsRound: false },
        { name: "done", statusId: status("Done"), default: false, needsYou: false, countsAsRound: false },
        { name: "needs you", statusId: status("Ready"), default: false, needsYou: true, countsAsRound: false },
      ],
    });
    await deliver(app, "check_run", checkRunEvent(installation, cronker, { id: 10, name: "test", sha: "c1", status: "completed", conclusion: "failure" }));

    await finishImplementing();

    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("Implement") });
    const runs = await ok("GET", `/api/tickets/${ticket.id}/runs`, cookie);
    expect(runs.map((r: { state: string; statusName: string }) => r.state)).toEqual(["finished", "running"]);
    expect(cronk.runner.stops).toEqual([]);
  });

  const failing = (installation: StandInInstallation, repository: StandInRepository, sha: string) =>
    checkRunEvent(installation, repository, { id: 10, name: "test", sha, status: "completed", conclusion: "failure" });

  test("a Pull Request no Run opened sends nothing back", async () => {
    const { cookie, app, installation, project, cronker } = await projectWithRepository();
    const ticket = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Ada's own" });
    await deliver(app, "pull_request", pullRequestEvent("opened", installation, cronker, { id: 501, number: 7, title: "CRONK-1", branch: "b", sha: "c1" }));
    await ok("PATCH", `/api/tickets/${ticket.id}`, cookie, { statusId: statusNamed(project, "In Review") });

    await deliver(app, "check_run", failing(installation, cronker, "c1"));
    await deliver(app, "pull_request_review", reviewEvent(installation, cronker, { id: 501, number: 7, title: "CRONK-1", branch: "b", sha: "c1" }, { id: 72, state: "changes_requested", reviewer: "bea" }));

    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: statusNamed(project, "In Review") });
    expect(await commentsOf(ticket.id, cookie)).toEqual([]);
  });

  test("a Ticket outside a Review Status is not sent back", async () => {
    const { cookie, app, installation, cronker, ticket, pr, status } = await inReview();
    await ok("PATCH", `/api/tickets/${ticket.id}`, cookie, { statusId: status("Backlog") });

    await deliver(app, "check_run", failing(installation, cronker, "c1"));
    await deliver(app, "pull_request_review", reviewEvent(installation, cronker, pr, { id: 72, state: "changes_requested", reviewer: "bea" }));

    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("Backlog") });
    expect(await commentsOf(ticket.id, cookie)).toEqual([]);
  });

  test("a Ticket of a Project that removed the Repository since is not sent back", async () => {
    const { workspace, cookie, app, installation, project, cronker, ticket, pr, status } = await inReview();
    const website = await post(cookie, `/api/workspaces/${workspace.id}/projects`, { name: "Website", key: "WEB" });
    await post(cookie, `/api/projects/${website.id}/repositories`, { id: cronker.id });
    expect((await cronk.request("DELETE", `/api/projects/${project.id}/repositories/${cronker.id}`, { cookie })).status).toBe(204);

    await deliver(app, "check_run", failing(installation, cronker, "c1"));
    await deliver(app, "pull_request_review", reviewEvent(installation, cronker, pr, { id: 72, state: "changes_requested", reviewer: "bea" }));

    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("In Review") });
    expect(await commentsOf(ticket.id, cookie)).toEqual([]);
  });

  test("in an archived Project, failing checks and requested changes send nothing back and only show on the Pull Request", async () => {
    const { cookie, app, installation, project, cronker, ticket, pr, status } = await inReview();
    await ok("POST", `/api/projects/${project.id}/archive`, cookie);

    await deliver(app, "check_run", failing(installation, cronker, "c1"));
    await deliver(app, "pull_request_review", reviewEvent(installation, cronker, pr, { id: 72, state: "changes_requested", reviewer: "bea" }));

    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("In Review") });
    expect(await commentsOf(ticket.id, cookie)).toEqual([]);
    expect(await pullRequestsOf(ticket.id, cookie)).toMatchObject([
      { checks: [{ name: "test", state: "failed" }], reviewState: { state: "changes_requested", reviewer: "bea" }, sentBack: null },
    ]);
  });

  test("with Pull Request automation off, failures only show on the Pull Request", async () => {
    const { cookie, app, installation, project, cronker, ticket, pr, status } = await inReview();
    await ok("PATCH", `/api/projects/${project.id}`, cookie, { pullRequestAutomation: false });

    await deliver(app, "check_run", failing(installation, cronker, "c1"));
    await deliver(app, "pull_request_review", reviewEvent(installation, cronker, pr, { id: 72, state: "changes_requested", reviewer: "bea" }));

    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("In Review") });
    expect(await commentsOf(ticket.id, cookie)).toEqual([]);
    expect(await pullRequestsOf(ticket.id, cookie)).toMatchObject([{ checks: [{ name: "test", state: "failed" }], sentBack: null }]);
  });

  test("reading the Ticket's Pull Requests shows what last sent it back", async () => {
    const { cookie, app, installation, cronker, ticket, pr, finishImplementing } = await inReview();
    cronk.clock.advance(hours(1));
    await deliver(app, "check_run", checkRunEvent(installation, cronker, { id: 10, name: "test", sha: "c1", status: "completed", conclusion: "failure" }));
    expect((await pullRequestsOf(ticket.id, cookie))[0].sentBack).toEqual({
      kind: "check",
      name: "test",
      sha: "c1",
      url: "https://github.com/cronkcorp/cronker/runs/10",
      at: "2026-01-01T10:00:00.000Z",
    });
    await finishImplementing();

    cronk.clock.advance(hours(1));
    await deliver(app, "pull_request_review", reviewEvent(installation, cronker, pr, { id: 72, state: "changes_requested", reviewer: "bea" }));

    expect((await pullRequestsOf(ticket.id, cookie))[0]).toMatchObject({
      reviewState: { state: "changes_requested", reviewer: "bea", url: "https://github.com/cronkcorp/cronker/pull/7#pullrequestreview-72" },
      sentBack: {
        kind: "review",
        reviewer: "bea",
        url: "https://github.com/cronkcorp/cronker/pull/7#pullrequestreview-72",
        at: "2026-01-01T11:00:00.000Z",
      },
    });

    // An approval that follows replaces the review state; what sent the Ticket back stays.
    await deliver(app, "pull_request_review", reviewEvent(installation, cronker, pr, { id: 73, state: "approved", reviewer: "bea" }));
    expect((await pullRequestsOf(ticket.id, cookie))[0]).toMatchObject({
      reviewState: { state: "approved", reviewer: "bea" },
      sentBack: { kind: "review", reviewer: "bea" },
    });
  });

  test("a check failing on a new commit before GitHub reports the push sends the Ticket back once the push is reported", async () => {
    const { cookie, app, installation, cronker, ticket, pr, status } = await inReview();

    await deliver(app, "check_run", checkRunEvent(installation, cronker, { id: 10, name: "test", sha: "c2", status: "completed", conclusion: "failure" }));
    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("In Review") });
    await deliver(app, "pull_request", pullRequestEvent("synchronize", installation, cronker, { ...pr, sha: "c2", updatedAt: "2026-01-01T10:00:00Z" }));

    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("Implement") });
    expect((await commentsOf(ticket.id, cookie)).map((c: { body: string }) => c.body.split(" on ")[0])).toEqual([
      "The check [**test**](https://github.com/cronkcorp/cronker/runs/10) failed",
    ]);
  });

  test("a producing Status whose Step was removed since sends nothing back", async () => {
    const { cookie, app, installation, project, cronker, ticket, status } = await inReview();
    const removed = await cronk.request("DELETE", `/api/projects/${project.id}/statuses/${status("Implement")}/step`, { cookie });
    expect(removed.status, await removed.clone().text()).toBeLessThan(300);

    await deliver(app, "check_run", failing(installation, cronker, "c1"));

    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("In Review") });
    expect(await commentsOf(ticket.id, cookie)).toEqual([]);
  });
});

describe("Send-back Comments written before they were marked", () => {
  test("Cronk's earlier Comments, each a send-back, are marked as one; other Comments are not", async () => {
    await cronk.stop();
    cronk = await startCronk({ migrateBefore: "0031_sent_back_comments.sql" });
    // Setting up and creating a Project, as today's API does, needs Workspace slugs and the Merge Step's columns;
    // reading a Ticket needs the columns of Runs' costs; finding a Project or a Ticket needs Access; reading a User needs display
    // names; creating a Ticket needs the Mention index, Embeds and Term Mentions among it; finding a Project needs Concise Reports;
    // any Access needs archived Projects; reading a Ticket needs conflict markers, and its place in the Merge Queue with
    // its Pull Request's base branch and the conflict that last set it aside.
    await cronk.applyAhead("0033_merge_step.sql");
    await cronk.applyAhead("0044_workspace_slugs.sql");
    await cronk.applyAhead("0049_run_costs.sql");
    await cronk.applyAhead("0051_access.sql");
    await cronk.applyAhead("0053_display_name.sql");
    await cronk.applyAhead("0055_mentions.sql");
    await cronk.applyAhead("0057_embeds.sql");
    await cronk.applyAhead("0068_decision_mentions.sql");
    await cronk.applyAhead("0070_term_mentions.sql");
    await cronk.applyAhead("0056_concise_reports.sql");
    await cronk.applyAhead("0057_archived_projects.sql");
    await cronk.applyAhead("0059_conflict_markers.sql");
    await cronk.applyAhead("0042_merge_conflicts.sql");
    await cronk.applyAhead("0061_merge_queue.sql");
    await cronk.applyAhead("0065_merge_queue_conflicts.sql");
    const { workspace, user } = await setUp(cronk);
    const cookie = await signIn(cronk);
    const project = await post(cookie, `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
    const ticket = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Make it so" });
    for (const [userId, body] of [
      [null, "The check **test** failed on cronkcorp/cronker#7's latest commit `c1`. Sent CRONK-1 back to Implement."],
      [user.id, "Looking into it."],
    ]) {
      await cronk.stage(
        `insert into comments (workspace_id, ticket_id, actor_user_id, body, created_at) values ($1, $2, $3, $4, '2026-01-01T09:00:00Z')`,
        [workspace.id, ticket.id, userId, body],
      );
    }

    await cronk.upgrade();

    const response = await cronk.request("GET", `/api/tickets/${ticket.id}/comments`, { cookie });
    expect(response.status).toBe(200);
    expect((await response.json()).map((c: { actor: { kind: string }; sentBack: boolean }) => [c.actor.kind, c.sentBack])).toEqual([
      ["cronk", true],
      ["user", false],
    ]);
  });
});

describe("Pull Requests linked by hand", () => {
  const link = (cookie: string, ticketId: string, pullRequest: string) =>
    cronk.request("POST", `/api/tickets/${ticketId}/pull-requests`, { cookie, body: { pullRequest } });
  const unlink = (cookie: string, ticketId: string, pullRequestId: number) =>
    cronk.request("DELETE", `/api/tickets/${ticketId}/pull-requests/${pullRequestId}`, { cookie });
  const ticketOf = async (ticketId: string, cookie: string) =>
    (await cronk.request("GET", `/api/tickets/${ticketId}`, { cookie })).json();
  const linked = async (ticketId: string, cookie: string) =>
    (await pullRequestsOf(ticketId, cookie)).map((pr: { id: number; manual: boolean }) => [pr.id, pr.manual]);
  const unnamed = { id: 501, number: 7, title: "Tidy the board", branch: "tidy-board" };

  test("a User links a Pull Request naming no key by its address or as owner/name#number, and unlinks it", async () => {
    const { workspace, cookie, app, installation, project, cronker } = await projectWithRepository();
    const ticket = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Linked by hand" });
    await deliver(app, "pull_request", pullRequestEvent("opened", installation, cronker, unnamed));
    await deliver(app, "pull_request", pullRequestEvent("opened", installation, cronker, { id: 502, number: 8, title: "Other", branch: "other" }));
    expect(await pullRequestsOf(ticket.id, cookie)).toEqual([]);
    const stream = await openStream(cronk, cookie, workspace.id);

    const byUrl = await link(cookie, ticket.id, "https://github.com/cronkcorp/cronker/pull/7");
    expect(byUrl.status, await byUrl.clone().text()).toBe(201);
    expect(await byUrl.json()).toMatchObject({ id: 501, number: 7, title: "Tidy the board", manual: true, producingStep: null });
    expect(await stream.next()).toEqual({ type: "pull_requests.changed", data: { projectId: project.id, ticketId: ticket.id } });
    expect((await link(cookie, ticket.id, "CronkCorp/Cronker#8")).status).toBe(201);
    // Linking again changes nothing.
    expect((await link(cookie, ticket.id, "cronkcorp/cronker#7")).status).toBe(201);
    expect(await linked(ticket.id, cookie)).toEqual([[501, true], [502, true]]);

    expect((await unlink(cookie, ticket.id, 501)).status).toBe(204);
    expect(await stream.next()).toEqual({ type: "pull_requests.changed", data: { projectId: project.id, ticketId: ticket.id } });
    expect(await linked(ticket.id, cookie)).toEqual([[502, true]]);
    expect((await unlink(cookie, ticket.id, 501)).status).toBe(404);
    stream.close();
  });

  test("a link by hand survives GitHub's deliveries again and edits of the title and branch", async () => {
    const { cookie, app, installation, project, cronker } = await projectWithRepository();
    const ticket = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Kept" });
    await deliver(app, "pull_request", pullRequestEvent("opened", installation, cronker, unnamed));
    expect((await link(cookie, ticket.id, "cronkcorp/cronker#7")).status).toBe(201);

    await deliver(app, "pull_request", pullRequestEvent("opened", installation, cronker, unnamed));
    await deliver(
      app,
      "pull_request",
      pullRequestEvent("edited", installation, cronker, { ...unnamed, title: "Tidy the whole board", branch: "tidy", updatedAt: "2026-01-01T10:00:00Z" }),
    );

    expect(await pullRequestsOf(ticket.id, cookie)).toMatchObject([{ id: 501, title: "Tidy the whole board", branch: "tidy", manual: true }]);
  });

  test("a link by hand and one by key on the same Pull Request are kept apart: unlinking leaves the key's, which can't be unlinked", async () => {
    const { cookie, app, installation, project, cronker } = await projectWithRepository();
    const ticket = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Both ways" });
    expect((await link(cookie, ticket.id, "cronkcorp/cronker#7")).status).toBe(404);
    await deliver(app, "pull_request", pullRequestEvent("opened", installation, cronker, unnamed));
    expect((await link(cookie, ticket.id, "cronkcorp/cronker#7")).status).toBe(201);
    // The title comes to name the key too.
    await deliver(
      app,
      "pull_request",
      pullRequestEvent("edited", installation, cronker, { ...unnamed, title: "CRONK-1: tidy", updatedAt: "2026-01-01T10:00:00Z" }),
    );

    expect((await unlink(cookie, ticket.id, 501)).status).toBe(204);
    expect(await linked(ticket.id, cookie)).toEqual([[501, false]]);
    const byKey = await unlink(cookie, ticket.id, 501);
    expect(byKey.status).toBe(409);
    expect((await byKey.json()).error.code).toBe("linked_by_key");
    // Linked by hand again, a later delivery naming the key leaves it linked by hand.
    expect((await link(cookie, ticket.id, "cronkcorp/cronker#7")).status).toBe(201);
    await deliver(
      app,
      "pull_request",
      pullRequestEvent("edited", installation, cronker, { ...unnamed, title: "CRONK-1: tidy it", updatedAt: "2026-01-01T11:00:00Z" }),
    );
    expect(await linked(ticket.id, cookie)).toEqual([[501, true]]);
  });

  test("only an open or merged Pull Request of a Repository the Ticket's Project lists links, named properly", async () => {
    const { workspace, cookie, app, installation, project, cronker, website } = await projectWithRepository();
    const ticket = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Picky" });
    // Another Project lists `website`, so Cronk knows its Pull Requests, but CRONK doesn't list it.
    const web = await post(cookie, `/api/workspaces/${workspace.id}/projects`, { name: "Website", key: "WEB" });
    await post(cookie, `/api/projects/${web.id}/repositories`, { id: website.id });
    await deliver(app, "pull_request", pullRequestEvent("opened", installation, website, { id: 601, number: 7, title: "Site", branch: "site" }));
    await deliver(app, "pull_request", pullRequestEvent("closed", installation, cronker, { ...unnamed, state: "closed" }));
    const merged = { id: 503, number: 9, title: "Shipped", branch: "shipped", state: "closed" as const, merged: true };
    await deliver(app, "pull_request", pullRequestEvent("closed", installation, cronker, merged));

    const refusals: [string, number, string][] = [
      ["cronkcorp/website#7", 404, "pull_request_not_found"],
      ["cronkcorp/cronker#7", 409, "pull_request_closed"],
      ["cronkcorp/cronker#99", 404, "pull_request_not_found"],
      ["#7", 400, "invalid_pull_request"],
      ["https://github.com/cronkcorp/cronker/issues/7", 400, "invalid_pull_request"],
    ];
    for (const [named, status, code] of refusals) {
      const refused = await link(cookie, ticket.id, named);
      expect(refused.status, named).toBe(status);
      expect((await refused.json()).error.code, named).toBe(code);
    }
    expect((await link(cookie, ticket.id, "cronkcorp/cronker#9")).status).toBe(201);
    expect(await pullRequestsOf(ticket.id, cookie)).toMatchObject([{ id: 503, state: "merged", manual: true }]);
    // A merge before the link completes nothing.
    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: ticket.statusId, verification: null });
  });

  test("a Pull Request can't be linked to, or unlinked from, a Ticket of another Workspace", async () => {
    const { cookie, app, installation, project, cronker } = await projectWithRepository();
    const ours = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Ada's" });
    const other = await post(cookie, "/api/workspaces", { name: "Bea's Workspace" });
    const bea = await addMember(cronk, cookie, other.id, "bea@example.com");
    const beasProject = await post(bea.cookie, `/api/workspaces/${other.id}/projects`, { name: "Bea's", key: "BEA" });
    await post(bea.cookie, `/api/projects/${beasProject.id}/repositories`, { id: cronker.id });
    const theirs = await post(bea.cookie, `/api/projects/${beasProject.id}/tickets`, { title: "Bea's" });
    await deliver(app, "pull_request", pullRequestEvent("opened", installation, cronker, unnamed));
    expect((await link(cookie, ours.id, "cronkcorp/cronker#7")).status).toBe(201);

    expect((await link(bea.cookie, ours.id, "cronkcorp/cronker#7")).status).toBe(404);
    expect((await unlink(bea.cookie, ours.id, 501)).status).toBe(404);
    // Bea links it to her own Ticket, whose Project lists the Repository too; Ada's link stays.
    expect((await link(bea.cookie, theirs.id, "cronkcorp/cronker#7")).status).toBe(201);
    expect(await linked(ours.id, cookie)).toEqual([[501, true]]);
    expect(await linked(theirs.id, bea.cookie)).toEqual([[501, true]]);
  });

  test("an Agent reads links by hand but can't make or remove one", async () => {
    const { workspace, cookie, app, installation, project, cronker } = await projectWithRepository();
    const ticket = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Users only" });
    await deliver(app, "pull_request", pullRequestEvent("opened", installation, cronker, unnamed));
    expect((await link(cookie, ticket.id, "cronkcorp/cronker#7")).status).toBe(201);
    const agent = await post(cookie, `/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
    const { secret } = await post(cookie, `/api/agents/${agent.id}/tokens`, { name: "laptop", access: "full" });
    const headers = { authorization: `Bearer ${secret}` };

    const read = await cronk.request("GET", `/api/tickets/${ticket.id}/pull-requests`, { headers });
    expect(await read.json()).toMatchObject([{ id: 501, manual: true }]);
    const linking = await cronk.request("POST", `/api/tickets/${ticket.id}/pull-requests`, { headers, body: { pullRequest: "cronkcorp/cronker#7" } });
    expect(linking.status).toBe(403);
    expect((await linking.json()).error.code).toBe("agent_not_allowed");
    const unlinking = await cronk.request("DELETE", `/api/tickets/${ticket.id}/pull-requests/501`, { headers });
    expect(unlinking.status).toBe(403);
    expect(await linked(ticket.id, cookie)).toEqual([[501, true]]);
  });

  test("a merge completes a Ticket linked by hand under the same rules as one linked by key", async () => {
    const { workspace, cookie, app, installation, project, cronker } = await projectWithRepository();
    const account = cronk.github.account("bea", "bea@example.com");
    expect((await cronk.request("POST", `/api/workspaces/${workspace.id}/members/github`, { cookie, body: { login: "bea" } })).status).toBe(201);
    await signInWithGitHub(cronk, account);
    const done = project.statuses.find((s: { name: string }) => s.name === "Done")!.id;
    const byUser = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Merged by Bea" });
    const byOutsider = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Merged by Mallory" });
    const automationOff = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Unlinked again" });
    const prs = [1, 2, 3].map((n) => ({ id: 500 + n, number: n, title: `Change ${n}`, branch: `change-${n}` }));
    for (const pr of prs) await deliver(app, "pull_request", pullRequestEvent("opened", installation, cronker, pr));
    for (const [ticket, n] of [[byUser, 1], [byOutsider, 2], [automationOff, 3]] as const) {
      expect((await link(cookie, ticket.id, `cronkcorp/cronker#${n}`)).status).toBe(201);
    }
    const merged = (pr: PullRequestFields, mergedBy: { login: string; id: number }) =>
      pullRequestEvent("closed", installation, cronker, { ...pr, state: "closed", merged: true, mergedBy, updatedAt: "2026-01-01T12:00:00Z" });

    await deliver(app, "pull_request", merged(prs[0]!, { login: "bea", id: account.id }));
    await deliver(app, "pull_request", merged(prs[1]!, { login: "mallory", id: 666 }));
    expect(await ticketOf(byUser.id, cookie)).toMatchObject({ statusId: done, verification: "verified" });
    expect(await ticketOf(byOutsider.id, cookie)).toMatchObject({ statusId: done, verification: "unverified" });

    expect((await cronk.request("PATCH", `/api/projects/${project.id}`, { cookie, body: { pullRequestAutomation: false } })).status).toBe(200);
    await deliver(app, "pull_request", merged(prs[2]!, { login: "bea", id: account.id }));
    expect(await ticketOf(automationOff.id, cookie)).toMatchObject({ statusId: automationOff.statusId, verification: null });
  });
});
