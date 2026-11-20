import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { hours, seconds } from "../harness/clock.js";
import { createGitHubApp, setUp, signIn } from "../harness/flows.js";
import type { StandInApp, StandInInstallation, StandInRepository } from "../harness/github.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

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

describe("A merge making another Pull Request conflicting", () => {
  test("sends the Ticket of a conflicting Pull Request on the same base branch back to its producing Step, with a Comment naming the merge", async () => {
    const { cookie, cronker, ticket, status, mergeAnother } = await inReview();
    cronk.github.pullRequest(cronker, 7, { base: "main", baseSha: "m1", answers: [false] });

    await mergeAnother(9, "m1");
    await cronk.checkMergeability();

    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("Implement") });
    const comments = await commentsOf(ticket.id, cookie);
    expect(comments.map((c: { actor: unknown; body: string; sentBack: boolean }) => [c.actor, c.body, c.sentBack])).toEqual([
      [
        { kind: "cronk", name: "Cronk" },
        "[cronkcorp/cronker#9](https://github.com/cronkcorp/cronker/pull/9) merged into `main` as `m1`, and now " +
          "[cronkcorp/cronker#7](https://github.com/cronkcorp/cronker/pull/7) conflicts with it. Sent CRONK-1 back to Implement.",
        true,
      ],
    ]);
    // Back in Implement, the delegated Ticket gets a new Run there.
    const runs = await ok("GET", `/api/tickets/${ticket.id}/runs`, cookie);
    expect(runs.map((r: { state: string }) => r.state)).toEqual(["finished", "running"]);
  });
});

describe("Asking GitHub while it works mergeability out", () => {
  const asks = () => cronk.github.apiCalls.filter((c) => c === "GET /repos/cronkcorp/cronker/pulls/7").length;

  test("a null mergeability is asked again shortly, and a conflict GitHub then finds sends the Ticket back", async () => {
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
    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("In Review") });
    cronk.clock.advance(seconds(10));
    await cronk.checkMergeability();

    expect(asks()).toBe(3);
    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("Implement") });
  });

  test("Cronk stops asking after six tries without an answer, and GitHub being unavailable counts as one", async () => {
    const { cookie, cronker, ticket, status, mergeAnother } = await inReview();
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
    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("In Review") });
  });

  test("an answer GitHub worked out against the base before the merge is asked again", async () => {
    const { cookie, cronker, ticket, status, mergeAnother } = await inReview();
    cronk.github.pullRequest(cronker, 7, { base: "main", baseSha: "m1", answers: [{ mergeable: true, baseSha: "b0" }, false] });
    await mergeAnother(9, "m1");

    await cronk.checkMergeability();
    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("In Review") });
    cronk.clock.advance(seconds(10));
    await cronk.checkMergeability();

    expect(asks()).toBe(2);
    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("Implement") });
  });

  test("a Pull Request that merges cleanly into the merge's commit is asked about once and sends nothing back", async () => {
    const { cookie, cronker, ticket, status, mergeAnother } = await inReview();
    cronk.github.pullRequest(cronker, 7, { base: "main", baseSha: "m1", answers: [true] });
    await mergeAnother(9, "m1");

    await cronk.checkMergeability();
    cronk.clock.advance(hours(1));
    await cronk.checkMergeability();

    expect(asks()).toBe(1);
    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("In Review") });
    expect(await commentsOf(ticket.id, cookie)).toEqual([]);
  });
});

describe("An Outcome moving a Ticket into a Review Status", () => {
  test("has Cronk ask about its Pull Request, and one already conflicting sends it back, naming the latest merge Cronk knows into its base", async () => {
    const { cookie, cronker, ticket, status, finishImplementing, mergeAnother } = await implementing();
    cronk.github.pullRequest(cronker, 7, { base: "main", baseSha: "m1", answers: [false] });
    // While the Ticket is in Implement, a merge has Cronk ask nothing about it.
    await mergeAnother(9, "m1");
    await cronk.checkMergeability();
    expect(cronk.github.apiCalls.filter((c) => c.includes("/pulls/"))).toEqual([]);

    await finishImplementing();
    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("In Review") });
    await cronk.checkMergeability();

    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("Implement") });
    expect((await commentsOf(ticket.id, cookie)).map((c: { body: string }) => c.body)).toEqual([
      "[cronkcorp/cronker#9](https://github.com/cronkcorp/cronker/pull/9) merged into `main` as `m1`, and now " +
        "[cronkcorp/cronker#7](https://github.com/cronkcorp/cronker/pull/7) conflicts with it. Sent CRONK-1 back to Implement.",
    ]);
  });

  test("a conflict with a base commit other than the latest merge Cronk knows names that commit, not the merge", async () => {
    const { cookie, cronker, ticket, finishImplementing, mergeAnother } = await implementing();
    await mergeAnother(9, "m1");
    // The base branch moved on since, by a push Cronk doesn't watch.
    cronk.github.pullRequest(cronker, 7, { base: "main", baseSha: "p2", answers: [false] });

    await finishImplementing();
    await cronk.checkMergeability();

    expect((await commentsOf(ticket.id, cookie)).map((c: { body: string }) => c.body)).toEqual([
      "[cronkcorp/cronker#7](https://github.com/cronkcorp/cronker/pull/7) conflicts with its base branch `main` at `p2`. " +
        "Sent CRONK-1 back to Implement.",
    ]);
  });

  test("a conflict with no merge Cronk knows of names the base branch's commit GitHub compared against", async () => {
    const { cookie, cronker, ticket, status, finishImplementing } = await implementing();
    cronk.github.pullRequest(cronker, 7, { base: "main", baseSha: "0123456789abcdef", answers: [false] });

    await finishImplementing();
    await cronk.checkMergeability();

    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("Implement") });
    expect((await commentsOf(ticket.id, cookie)).map((c: { body: string }) => c.body)).toEqual([
      "[cronkcorp/cronker#7](https://github.com/cronkcorp/cronker/pull/7) conflicts with its base branch `main` at `0123456`. " +
        "Sent CRONK-1 back to Implement.",
    ]);
  });
});

describe("Conflicts as rounds", () => {
  test("a conflict counts as a round for the producing Step; past its round limit *needs you* applies, with Cronk's Question in the Inbox", async () => {
    const { workspace, project, cookie, cronker, ticket, status, finishImplementing, mergeAnother } = await inReview();
    const { step } = project.statuses.find((s: { name: string }) => s.name === "Implement");
    await ok("PUT", `/api/projects/${project.id}/statuses/${status("Implement")}/step`, cookie, { ...step, roundLimit: 1 });
    cronk.github.pullRequest(cronker, 7, { base: "main", baseSha: "m1", answers: [false] });
    await mergeAnother(9, "m1");
    await cronk.checkMergeability();
    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("Implement") });
    // The next round resolves it and comes back for review; then another merge conflicts again.
    cronk.github.pullRequest(cronker, 7, { base: "main", baseSha: "m1", answers: [true] });
    await finishImplementing();
    await cronk.checkMergeability();
    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("In Review") });
    cronk.github.pullRequest(cronker, 7, { base: "main", baseSha: "m2", answers: [false] });

    await mergeAnother(10, "m2");
    await cronk.checkMergeability();

    // Implement's *needs you* Outcome moves it to Ready.
    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("Ready") });
    const { items } = await ok("GET", `/api/workspaces/${workspace.id}/inbox`, cookie);
    expect(items.filter((i: { kind: string }) => i.kind === "needsYou")).toEqual([
      expect.objectContaining({
        ticket: expect.objectContaining({ key: "CRONK-1" }),
        outcome: "needs you",
        step: { statusId: status("Implement"), name: "Implement" },
        question:
          "Failing checks, requested changes and merge conflicts sent CRONK-1 back to Implement once, its round limit, " +
          "so it comes to you instead. Read the latest Comments, then move it on yourself.",
      }),
    ]);
    expect((await commentsOf(ticket.id, cookie)).at(-1).body).toBe(
      "[cronkcorp/cronker#10](https://github.com/cronkcorp/cronker/pull/10) merged into `main` as `m2`, and now " +
        "[cronkcorp/cronker#7](https://github.com/cronkcorp/cronker/pull/7) conflicts with it. " +
        "That is past Implement's round limit, so CRONK-1 comes to its Assignee instead.",
    );
  });
});

describe("What sent the Ticket back", () => {
  test("reading the Ticket's Pull Requests shows the conflict, and its timeline a Change by Cronk naming the merge, just before its move", async () => {
    const { cookie, cronker, ticket, status, mergeAnother } = await inReview();
    cronk.github.pullRequest(cronker, 7, { base: "main", baseSha: "m1", answers: [false] });
    cronk.clock.advance(hours(1));

    await mergeAnother(9, "m1");
    await cronk.checkMergeability();

    const merge = { repository: "cronkcorp/cronker", number: 9, url: "https://github.com/cronkcorp/cronker/pull/9" };
    expect((await ok("GET", `/api/tickets/${ticket.id}/pull-requests`, cookie))[0].sentBack).toEqual({
      kind: "conflict",
      branch: "main",
      sha: "m1",
      merge,
      at: "2026-01-01T10:00:00.000Z",
    });
    const changes = await ok("GET", `/api/tickets/${ticket.id}/timeline`, cookie);
    const sentBack = changes.findIndex((c: { field: string }) => c.field === "sentBack");
    expect(changes[sentBack]).toMatchObject({
      actor: { kind: "cronk" },
      from: null,
      to: {
        pullRequest: { id: 501, repository: "cronkcorp/cronker", number: 7, url: "https://github.com/cronkcorp/cronker/pull/7" },
        failure: { kind: "conflict", branch: "main", merge },
      },
    });
    expect(changes[sentBack + 1]).toMatchObject({ field: "status", to: { id: status("Implement") } });
  });
});

describe("Sending back once, and only where it applies", () => {
  const asked = () => cronk.github.apiCalls.filter((c) => c.includes("/pulls/"));

  test("a Pull Request whose base branch Cronk wasn't told is asked about after a merge, and sent back when GitHub says it is on that branch", async () => {
    const { cookie, cronker, ticket, status, mergeAnother } = await inReview({ withBase: false });
    cronk.github.pullRequest(cronker, 7, { base: "main", baseSha: "m1", answers: [false] });

    await mergeAnother(9, "m1");
    await cronk.checkMergeability();

    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("Implement") });
  });

  test("a Pull Request whose base branch Cronk wasn't told, conflicting on another branch than the merge's, is sent back without naming the merge", async () => {
    const { cookie, cronker, ticket, status, mergeAnother } = await inReview({ withBase: false });
    cronk.github.pullRequest(cronker, 7, { base: "release", baseSha: "r1", answers: [false] });

    await mergeAnother(9, "m1");
    await cronk.checkMergeability();

    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("Implement") });
    expect((await commentsOf(ticket.id, cookie)).map((c: { body: string }) => c.body)).toEqual([
      "[cronkcorp/cronker#7](https://github.com/cronkcorp/cronker/pull/7) conflicts with its base branch `release` at `r1`. " +
        "Sent CRONK-1 back to Implement.",
    ]);
  });

  test("the same base commit never sends the Ticket back twice, though it still conflicts when it comes back for review", async () => {
    const { cookie, cronker, ticket, status, finishImplementing, mergeAnother } = await inReview();
    cronk.github.pullRequest(cronker, 7, { base: "main", baseSha: "m1", answers: [false] });
    await mergeAnother(9, "m1");
    await cronk.checkMergeability();
    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("Implement") });

    await finishImplementing();
    await cronk.checkMergeability();

    expect(asked()).toHaveLength(2);
    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("In Review") });
    expect(await commentsOf(ticket.id, cookie)).toHaveLength(1);
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

  test("a Pull Request no Run opened sends nothing back", async () => {
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

    expect(asked()).toEqual([]);
    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: inReviewStatus });
    expect(await commentsOf(ticket.id, cookie)).toEqual([]);
  });

  test("a Ticket moved out of its Review Status before GitHub answers is not sent back", async () => {
    const { cookie, cronker, ticket, status, mergeAnother } = await inReview();
    cronk.github.pullRequest(cronker, 7, { base: "main", baseSha: "m1", answers: [false] });
    await mergeAnother(9, "m1");
    await ok("PATCH", `/api/tickets/${ticket.id}`, cookie, { statusId: status("Ready") });

    await cronk.checkMergeability();

    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("Ready") });
    expect(await commentsOf(ticket.id, cookie)).toEqual([]);
  });

  test("with Pull Request automation off, a merge has Cronk ask nothing and nothing is sent back", async () => {
    const { cookie, project, ticket, status, cronker, mergeAnother } = await inReview();
    await cronk.checkMergeability();
    await ok("PATCH", `/api/projects/${project.id}`, cookie, { pullRequestAutomation: false });
    cronk.github.pullRequest(cronker, 7, { base: "main", baseSha: "m1", answers: [false] });

    await mergeAnother(9, "m1");
    await cronk.checkMergeability();

    // Only the ask moving into In Review had Cronk make, with automation still on.
    expect(asked()).toHaveLength(1);
    expect(await ticketOf(ticket.id, cookie)).toMatchObject({ statusId: status("In Review") });
  });
});
