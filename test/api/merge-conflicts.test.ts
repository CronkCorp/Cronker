import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { hours, seconds } from "../harness/clock.js";
import { createGitHubApp, setUp, signIn } from "../harness/flows.js";
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

async function ok(method: string, path: string, cookie: string, body?: unknown) {
  const response = await cronk.request(method, path, { cookie, body });
  expect(response.status, await response.clone().text()).toBeLessThan(300);
  return response.json();
}

async function deliver(app: StandInApp, event: string, payload: unknown) {
  const delivered = await cronk.github.deliver(app, event, payload);
  expect(delivered.status, await delivered.clone().text()).toBe(200);
}

interface PullRequestFields {
  id: number;
  number: number;
  title: string;
  branch: string;
  sha?: string;
  base?: string;
  state?: "open" | "closed";
  merged?: boolean;
  mergeCommit?: string;
  updatedAt?: string;
}

/** A `pull_request` delivery as GitHub sends it, with only the fields Cronk reads. */
const pullRequestEvent = (action: string, installation: StandInInstallation, repository: StandInRepository, pr: PullRequestFields) => ({
  action,
  installation: { id: installation.id },
  repository: { id: repository.id, full_name: repository.fullName },
  pull_request: {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    state: pr.state ?? "open",
    draft: false,
    merged: pr.merged ?? false,
    merged_by: pr.merged ? { type: "User", login: "bea", id: 4001 } : null,
    merge_commit_sha: pr.mergeCommit ?? null,
    auto_merge: null,
    html_url: `https://github.com/${repository.fullName}/pull/${pr.number}`,
    head: { ref: pr.branch, sha: pr.sha ?? "aaaa" },
    base: { ref: pr.base ?? "main", sha: "b0" },
    updated_at: pr.updatedAt ?? "2026-01-01T09:00:00Z",
  },
});

/**
 * A delegated Ticket CRONK-1 whose Implement Run opened Pull Request 501 (#7 on `main`); finishing that Run with *done*
 * moves it, past Code review that its `no-review` Label skips, to In Review. The stand-in GitHub says #7 merges cleanly
 * until a test says otherwise.
 */
async function implementing({ withBase = true } = {}) {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  await createGitHubApp(cronk, cookie);
  const app = cronk.github.apps[0]!;
  const installation = cronk.github.install(app, "cronkcorp", ["cronker"]);
  const cronker = installation.repositories[0]!;
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, cookie, { name: "Cronker", key: "CRONK" });
  await ok("POST", `/api/projects/${project.id}/repositories`, cookie, { id: cronker.id });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id as string;
  const runner = await ok("POST", "/api/runners", cookie, { name: "Fake", kind: "fake" });
  const agent = await ok("POST", `/api/workspaces/${workspace.id}/agents`, cookie, { name: "claude-max" });
  await ok("PATCH", `/api/agents/${agent.id}`, cookie, { runnerId: runner.id });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, cookie, { name: "cloud", access: "full" });
  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, cookie, { title: "Make it so" });
  await ok("PATCH", `/api/tickets/${ticket.id}`, cookie, { delegateId: agent.id, labels: ["no-review"], statusId: status("Implement") });
  const pr = { id: 501, number: 7, title: "CRONK-1: make it so", branch: "b", sha: "c1" };
  const opened = pullRequestEvent("opened", installation, cronker, pr);
  // A delivery without its base, as GitHub's to an earlier Cronk that kept none.
  if (!withBase) delete (opened.pull_request as { base?: unknown }).base;
  await deliver(app, "pull_request", opened);
  /** The Agent finishes the Run running on the Ticket with *done*. */
  const finishImplementing = async () => {
    const running = (await ok("GET", `/api/tickets/${ticket.id}/runs`, cookie)).find((r: { state: string }) => r.state === "running");
    const finished = await cronk.request("POST", `/api/runs/${running.id}/finish`, {
      headers: { authorization: `Bearer ${secret}` },
      body: { outcome: "done" },
    });
    expect(finished.status, await finished.clone().text()).toBe(200);
  };
  /** Another Pull Request, linking no Ticket, merged into `main` as the merge commit `sha`. */
  const mergeAnother = async (number: number, sha: string, base = "main") => {
    const other = { id: 600 + number, number, title: "Speed up the board", branch: `other-${number}`, base };
    await deliver(app, "pull_request", pullRequestEvent("opened", installation, cronker, other));
    await deliver(
      app,
      "pull_request",
      pullRequestEvent("closed", installation, cronker, { ...other, state: "closed", merged: true, mergeCommit: sha, updatedAt: "2026-01-01T09:30:00Z" }),
    );
  };
  return { workspace, cookie, app, installation, cronker, project, status, ticket, pr, secret, finishImplementing, mergeAnother };
}

async function inReview(options?: { withBase?: boolean }) {
  const implemented = await implementing(options);
  await implemented.finishImplementing();
  expect(await ticketOf(implemented.ticket.id, implemented.cookie)).toMatchObject({ statusId: implemented.status("In Review") });
  return implemented;
}

const ticketOf = (ticketId: string, cookie: string) => ok("GET", `/api/tickets/${ticketId}`, cookie);
const commentsOf = (ticketId: string, cookie: string) => ok("GET", `/api/tickets/${ticketId}/comments`, cookie);
/** The conflict marker on the Ticket's first Pull Request, as reading its Pull Requests shows it. */
const conflictOf = async (ticketId: string, cookie: string) => (await ok("GET", `/api/tickets/${ticketId}/pull-requests`, cookie))[0].conflict;
const merge9 = { repository: "cronkcorp/cronker", number: 9, url: "https://github.com/cronkcorp/cronker/pull/9" };

/** The Ticket stayed where it was, with no Comment, no Change since `changes` and no new Run: nothing sent it back. */
async function notSentBack(ticketId: string, cookie: string, statusId: string, changes?: number) {
  expect(await ticketOf(ticketId, cookie)).toMatchObject({ statusId });
  expect(await commentsOf(ticketId, cookie)).toEqual([]);
  const timeline = await ok("GET", `/api/tickets/${ticketId}/timeline`, cookie);
  expect(timeline.filter((c: { field?: string }) => c.field === "sentBack")).toEqual([]);
  if (changes !== undefined) expect(timeline).toHaveLength(changes);
}

describe("A merge making another Pull Request conflicting", () => {
  test("marks the conflicting Pull Request on the same base branch, naming the merge, and leaves its Ticket in its Review Status", async () => {
    const { cookie, cronker, ticket, status, mergeAnother } = await inReview();
    const changes = (await ok("GET", `/api/tickets/${ticket.id}/timeline`, cookie)).length;
    cronk.github.pullRequest(cronker, 7, { base: "main", baseSha: "m1", answers: [false] });
    cronk.clock.advance(hours(1));

    await mergeAnother(9, "m1");
    await cronk.checkMergeability();

    await notSentBack(ticket.id, cookie, status("In Review"), changes);
    expect(await conflictOf(ticket.id, cookie)).toEqual({ branch: "main", sha: "m1", merge: merge9, at: "2026-01-01T10:00:00.000Z" });
    // The board's card shows it too.
    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ conflicts: ["main"] });
    // No new Run, and the Ticket's Pull Request shows nothing sent it back.
    const runs = await ok("GET", `/api/tickets/${ticket.id}/runs`, cookie);
    expect(runs.map((r: { state: string }) => r.state)).toEqual(["finished"]);
    expect((await ok("GET", `/api/tickets/${ticket.id}/pull-requests`, cookie))[0].sentBack).toBeNull();
  });

  test("tells the Ticket's Pull Requests and its card when the marker changes, and nothing when GitHub says the same again", async () => {
    const { workspace, project, app, installation, pr, cookie, cronker, ticket, mergeAnother } = await inReview();
    await cronk.checkMergeability();
    cronk.github.pullRequest(cronker, 7, { base: "main", baseSha: "m1", answers: [false] });
    await mergeAnother(9, "m1");
    const stream = await openStream(cronk, cookie, workspace.id);

    await cronk.checkMergeability();

    const data = { projectId: project.id, ticketId: ticket.id };
    expect(await stream.next()).toEqual({ type: "pull_requests.changed", data });
    expect(await stream.next()).toEqual({ type: "ticket.changed", data });
    // A push has Cronk ask again; GitHub answering the same conflict changes nothing to hear of.
    cronk.github.pullRequest(cronker, 7, { headSha: "c2", base: "main", baseSha: "m1", answers: [false] });
    await deliver(app, "pull_request", pullRequestEvent("synchronize", installation, cronker, { ...pr, sha: "c2", updatedAt: "2026-01-01T09:40:00Z" }));
    expect(await stream.next()).toEqual({ type: "pull_requests.changed", data });
    await cronk.checkMergeability();
    expect(cronk.github.apiCalls.filter((c) => c === "GET /repos/cronkcorp/cronker/pulls/7")).toHaveLength(3);
    await stream.expectQuiet();
    stream.close();
  });

  test("a later answer that it merges cleanly clears the marker", async () => {
    const { cookie, cronker, ticket, mergeAnother } = await inReview();
    cronk.github.pullRequest(cronker, 7, { base: "main", baseSha: "m1", answers: [false] });
    await mergeAnother(9, "m1");
    await cronk.checkMergeability();
    expect(await conflictOf(ticket.id, cookie)).toMatchObject({ branch: "main" });

    cronk.github.pullRequest(cronker, 7, { base: "main", baseSha: "m2", answers: [true] });
    await mergeAnother(10, "m2");
    await cronk.checkMergeability();

    expect(await conflictOf(ticket.id, cookie)).toBeNull();
    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ conflicts: [] });
  });

  test("a push to a marked Pull Request has Cronk ask again, and the marker goes once it merges cleanly", async () => {
    const { app, installation, cookie, cronker, ticket, pr, mergeAnother } = await inReview();
    cronk.github.pullRequest(cronker, 7, { base: "main", baseSha: "m1", answers: [false] });
    await mergeAnother(9, "m1");
    await cronk.checkMergeability();
    expect(await conflictOf(ticket.id, cookie)).not.toBeNull();

    cronk.github.pullRequest(cronker, 7, { headSha: "c2", base: "main", baseSha: "m1", answers: [true] });
    await deliver(app, "pull_request", pullRequestEvent("synchronize", installation, cronker, { ...pr, sha: "c2", updatedAt: "2026-01-01T09:40:00Z" }));
    await cronk.checkMergeability();

    expect(await conflictOf(ticket.id, cookie)).toBeNull();
  });

  test("a conflicting Pull Request that closes shows no marker", async () => {
    const { app, installation, cookie, cronker, ticket, pr, mergeAnother } = await inReview();
    cronk.github.pullRequest(cronker, 7, { base: "main", baseSha: "m1", answers: [false] });
    await mergeAnother(9, "m1");
    await cronk.checkMergeability();

    await deliver(app, "pull_request", pullRequestEvent("closed", installation, cronker, { ...pr, state: "closed", updatedAt: "2026-01-01T09:40:00Z" }));

    expect(await conflictOf(ticket.id, cookie)).toBeNull();
    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ conflicts: [] });
  });

  test("conflicts use up no rounds: past the producing Step's round limit, the Ticket still only gets the marker", async () => {
    const { workspace, project, cookie, cronker, ticket, status, mergeAnother } = await inReview();
    const { step } = project.statuses.find((s: { name: string }) => s.name === "Implement");
    await ok("PUT", `/api/projects/${project.id}/statuses/${status("Implement")}/step`, cookie, { ...step, roundLimit: 1 });
    cronk.github.pullRequest(cronker, 7, { base: "main", baseSha: "m1", answers: [false] });
    await mergeAnother(9, "m1");
    await cronk.checkMergeability();
    cronk.github.pullRequest(cronker, 7, { base: "main", baseSha: "m2", answers: [false] });

    await mergeAnother(10, "m2");
    await cronk.checkMergeability();

    await notSentBack(ticket.id, cookie, status("In Review"));
    const { items } = await ok("GET", `/api/workspaces/${workspace.id}/inbox`, cookie);
    expect(items.filter((i: { kind: string }) => i.kind === "needsYou")).toEqual([]);
    expect(await conflictOf(ticket.id, cookie)).toMatchObject({ sha: "m2", merge: { number: 10 } });
  });
});

describe("Asking GitHub while it works mergeability out", () => {
  const asks = () => cronk.github.apiCalls.filter((c) => c === "GET /repos/cronkcorp/cronker/pulls/7").length;

  test("a null mergeability is asked again shortly, and a conflict GitHub then finds marks the Pull Request", async () => {
    const { cookie, cronker, ticket, status, mergeAnother } = await inReview();
    cronk.github.pullRequest(cronker, 7, { base: "main", baseSha: "m1", answers: [null, null, false] });
    await mergeAnother(9, "m1");

    await cronk.checkMergeability();
    expect(asks()).toBe(1);
    // Not yet time to ask again.
    await cronk.checkMergeability();
    expect(asks()).toBe(1);
    cronk.clock.advance(seconds(10));
    await cronk.checkMergeability();
    expect(asks()).toBe(2);
    expect(await conflictOf(ticket.id, cookie)).toBeNull();
    cronk.clock.advance(seconds(10));
    await cronk.checkMergeability();

    expect(asks()).toBe(3);
    expect(await conflictOf(ticket.id, cookie)).toMatchObject({ branch: "main", sha: "m1" });
    await notSentBack(ticket.id, cookie, status("In Review"));
  });

  test("Cronk stops asking after six tries without an answer, and GitHub being unavailable counts as one", async () => {
    const { cookie, cronker, ticket, mergeAnother } = await inReview();
    cronk.github.pullRequest(cronker, 7, { base: "main", baseSha: "m1", answers: [null] });
    await mergeAnother(9, "m1");

    cronk.github.unavailable = true;
    await cronk.checkMergeability();
    cronk.github.unavailable = false;
    for (let i = 0; i < 10; i++) {
      cronk.clock.advance(seconds(10));
      await cronk.checkMergeability();
    }

    expect(asks()).toBe(6);
    expect(await conflictOf(ticket.id, cookie)).toBeNull();
  });

  test("an answer GitHub worked out against the base before the merge is asked again", async () => {
    const { cookie, cronker, ticket, mergeAnother } = await inReview();
    cronk.github.pullRequest(cronker, 7, { base: "main", baseSha: "m1", answers: [{ mergeable: true, baseSha: "b0" }, false] });
    await mergeAnother(9, "m1");

    await cronk.checkMergeability();
    expect(await conflictOf(ticket.id, cookie)).toBeNull();
    cronk.clock.advance(seconds(10));
    await cronk.checkMergeability();

    expect(asks()).toBe(2);
    expect(await conflictOf(ticket.id, cookie)).toMatchObject({ sha: "m1" });
  });

  test("a stale clean answer never clears a marker", async () => {
    const { cookie, cronker, ticket, mergeAnother } = await inReview();
    cronk.github.pullRequest(cronker, 7, { base: "main", baseSha: "m1", answers: [false] });
    await mergeAnother(9, "m1");
    await cronk.checkMergeability();
    cronk.github.pullRequest(cronker, 7, { base: "main", baseSha: "m2", answers: [{ mergeable: true, baseSha: "m1" }] });

    await mergeAnother(10, "m2");
    await cronk.checkMergeability();

    expect(await conflictOf(ticket.id, cookie)).toMatchObject({ sha: "m1" });
  });

  test("a Pull Request that merges cleanly into the merge's commit is asked about once and gets no marker", async () => {
    const { cookie, cronker, ticket, status, mergeAnother } = await inReview();
    cronk.github.pullRequest(cronker, 7, { base: "main", baseSha: "m1", answers: [true] });
    await mergeAnother(9, "m1");

    await cronk.checkMergeability();
    cronk.clock.advance(hours(1));
    await cronk.checkMergeability();

    expect(asks()).toBe(1);
    expect(await conflictOf(ticket.id, cookie)).toBeNull();
    await notSentBack(ticket.id, cookie, status("In Review"));
  });
});

describe("An Outcome moving a Ticket into a Review Status", () => {
  test("has Cronk ask about its Pull Request, and one already conflicting is marked, naming the latest merge Cronk knows into its base", async () => {
    const { cookie, cronker, ticket, status, finishImplementing, mergeAnother } = await implementing();
    cronk.github.pullRequest(cronker, 7, { base: "main", baseSha: "m1", answers: [false] });
    // While the Ticket is in Implement, a merge has Cronk ask nothing about it.
    await mergeAnother(9, "m1");
    await cronk.checkMergeability();
    expect(cronk.github.apiCalls.filter((c) => c.includes("/pulls/"))).toEqual([]);

    await finishImplementing();
    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("In Review") });
    await cronk.checkMergeability();

    await notSentBack(ticket.id, cookie, status("In Review"));
    expect(await conflictOf(ticket.id, cookie)).toMatchObject({ branch: "main", sha: "m1", merge: merge9 });
  });

  test("a conflict with a base commit other than the latest merge Cronk knows names that commit, not the merge", async () => {
    const { cookie, cronker, ticket, finishImplementing, mergeAnother } = await implementing();
    await mergeAnother(9, "m1");
    // The base branch moved on since, by a push Cronk doesn't watch.
    cronk.github.pullRequest(cronker, 7, { base: "main", baseSha: "p2", answers: [false] });

    await finishImplementing();
    await cronk.checkMergeability();

    expect(await conflictOf(ticket.id, cookie)).toMatchObject({ branch: "main", sha: "p2", merge: null });
  });

  test("a conflict with no merge Cronk knows of names the base branch's commit GitHub compared against", async () => {
    const { cookie, cronker, ticket, status, finishImplementing } = await implementing();
    cronk.github.pullRequest(cronker, 7, { base: "main", baseSha: "0123456789abcdef", answers: [false] });

    await finishImplementing();
    await cronk.checkMergeability();

    await notSentBack(ticket.id, cookie, status("In Review"));
    expect(await conflictOf(ticket.id, cookie)).toMatchObject({ branch: "main", sha: "0123456789abcdef", merge: null });
  });

  test("a failing check Cronk already knows still sends it back, conflicting or not", async () => {
    const { app, cookie, cronker, ticket, status, finishImplementing } = await implementing();
    cronk.github.pullRequest(cronker, 7, { base: "main", baseSha: "m1", answers: [false] });
    await deliver(app, "check_run", {
      repository: { id: cronker.id },
      check_run: { id: 31, name: "test", head_sha: "c1", status: "completed", conclusion: "failure", html_url: "https://ci/31" },
    });

    await finishImplementing();
    await cronk.checkMergeability();

    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("Implement") });
    expect((await commentsOf(ticket.id, cookie)).map((c: { body: string }) => c.body)).toEqual([
      "The check [**test**](https://ci/31) failed on [cronkcorp/cronker#7](https://github.com/cronkcorp/cronker/pull/7)'s " +
        "latest commit `c1`. Sent CRONK-1 back to Implement.",
    ]);
  });
});

describe("Marking only where it applies", () => {
  const asked = () => cronk.github.apiCalls.filter((c) => c.includes("/pulls/"));

  test("a Pull Request whose base branch Cronk wasn't told is asked about after a merge, and marked when GitHub says it is on that branch", async () => {
    const { cookie, cronker, ticket, status, mergeAnother } = await inReview({ withBase: false });
    cronk.github.pullRequest(cronker, 7, { base: "main", baseSha: "m1", answers: [false] });

    await mergeAnother(9, "m1");
    await cronk.checkMergeability();

    await notSentBack(ticket.id, cookie, status("In Review"));
    expect(await conflictOf(ticket.id, cookie)).toMatchObject({ branch: "main", sha: "m1", merge: merge9 });
  });

  test("a Pull Request whose base branch Cronk wasn't told, conflicting on another branch than the merge's, is marked without naming the merge", async () => {
    const { cookie, cronker, ticket, mergeAnother } = await inReview({ withBase: false });
    cronk.github.pullRequest(cronker, 7, { base: "release", baseSha: "r1", answers: [false] });

    await mergeAnother(9, "m1");
    await cronk.checkMergeability();

    expect(await conflictOf(ticket.id, cookie)).toMatchObject({ branch: "release", sha: "r1", merge: null });
    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ conflicts: ["release"] });
  });

  test("a merge into another base branch has Cronk ask nothing", async () => {
    const { mergeAnother } = await inReview();
    // Moving into In Review had Cronk ask once already.
    await cronk.checkMergeability();
    expect(asked()).toHaveLength(1);

    await mergeAnother(9, "m1", "release");
    await cronk.checkMergeability();

    expect(asked()).toHaveLength(1);
  });

  test("a Pull Request no Run opened is marked too", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    await createGitHubApp(cronk, cookie);
    const app = cronk.github.apps[0]!;
    const installation = cronk.github.install(app, "cronkcorp", ["cronker"]);
    const cronker = installation.repositories[0]!;
    const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, cookie, { name: "Cronker", key: "CRONK" });
    await ok("POST", `/api/projects/${project.id}/repositories`, cookie, { id: cronker.id });
    const inReviewStatus = project.statuses.find((s: { name: string }) => s.name === "In Review").id;
    const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, cookie, { title: "Make it so" });
    await ok("PATCH", `/api/tickets/${ticket.id}`, cookie, { statusId: inReviewStatus });
    await deliver(app, "pull_request", pullRequestEvent("opened", installation, cronker, { id: 501, number: 7, title: "CRONK-1", branch: "b" }));
    cronk.github.pullRequest(cronker, 7, { base: "main", baseSha: "m1", answers: [false] });

    const other = { id: 609, number: 9, title: "Other", branch: "o" };
    await deliver(app, "pull_request", pullRequestEvent("opened", installation, cronker, other));
    await deliver(app, "pull_request", pullRequestEvent("closed", installation, cronker, { ...other, state: "closed", merged: true, mergeCommit: "m1", updatedAt: "2026-01-01T09:30:00Z" }));
    await cronk.checkMergeability();

    expect(asked()).toHaveLength(1);
    await notSentBack(ticket.id, cookie, inReviewStatus);
    expect(await conflictOf(ticket.id, cookie)).toMatchObject({ branch: "main", sha: "m1" });
  });

  test("a Ticket moved out of its Review Status before GitHub answers stays where it was", async () => {
    const { cookie, cronker, ticket, status, mergeAnother } = await inReview();
    cronk.github.pullRequest(cronker, 7, { base: "main", baseSha: "m1", answers: [false] });
    await mergeAnother(9, "m1");
    await ok("PATCH", `/api/tickets/${ticket.id}`, cookie, { statusId: status("Ready") });

    await cronk.checkMergeability();

    await notSentBack(ticket.id, cookie, status("Ready"));
  });

  test("in an archived Project, a merge has Cronk ask nothing", async () => {
    const { cookie, project, ticket, status, cronker, mergeAnother } = await inReview();
    await cronk.checkMergeability();
    await ok("POST", `/api/projects/${project.id}/archive`, cookie);
    cronk.github.pullRequest(cronker, 7, { base: "main", baseSha: "m1", answers: [false] });

    await mergeAnother(9, "m1");
    await cronk.checkMergeability();

    // Only the ask moving into In Review had Cronk make, before the Project was archived.
    expect(asked()).toHaveLength(1);
    await notSentBack(ticket.id, cookie, status("In Review"));
    expect(await conflictOf(ticket.id, cookie)).toBeNull();
  });

  test("with Pull Request automation off, a merge has Cronk ask nothing", async () => {
    const { cookie, project, ticket, status, cronker, mergeAnother } = await inReview();
    await cronk.checkMergeability();
    await ok("PATCH", `/api/projects/${project.id}`, cookie, { pullRequestAutomation: false });
    cronk.github.pullRequest(cronker, 7, { base: "main", baseSha: "m1", answers: [false] });

    await mergeAnother(9, "m1");
    await cronk.checkMergeability();

    // Only the ask moving into In Review had Cronk make, with automation still on.
    expect(asked()).toHaveLength(1);
    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("In Review") });
    expect(await conflictOf(ticket.id, cookie)).toBeNull();
  });
});
