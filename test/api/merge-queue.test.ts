import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { seconds } from "../harness/clock.js";
import { addMember, createGitHubApp, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

// The Merge Queue (ADR 0011): a User's Merge queues a Ticket's Pull Request, and Cronk merges each queue's head in turn.

let cronk: StartedCronk;
beforeEach(async () => {
  cronk = await startCronk();
});
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

/**
 * Ada's Project on the default board, listing cronkcorp/cronker and cronkcorp/website, with the GitHub App installed on
 * both. `inReview(n)` creates CRONK-n in In Review with an open, green, mergeable Pull Request #n+100 on `base`.
 */
async function queueSetting() {
  const { workspace, user } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id as string;
  await createGitHubApp(cronk, ada.cookie);
  const app = cronk.github.apps[0]!;
  const installation = cronk.github.install(app, "cronkcorp", ["cronker", "website"]);
  const [cronker, website] = installation.repositories as [typeof installation.repositories[0], typeof installation.repositories[0]];
  for (const repository of [cronker, website]) await ok("POST", `/api/projects/${project.id}/repositories`, ada, { id: repository.id });

  const deliver = async (repository: typeof cronker, event: string, payload: Record<string, unknown>) => {
    const delivered = await cronk.github.deliver(app, event, {
      installation: { id: installation.id },
      repository: { id: repository.id, full_name: repository.fullName },
      ...payload,
    });
    expect(delivered.status).toBe(200);
  };
  const pullRequestOf = (number: number, key: string, repository = cronker, base = "main") => ({
    id: 500 + number,
    number,
    title: `${key}: make it so`,
    state: "open",
    draft: false,
    merged: false,
    html_url: `https://github.com/${repository.fullName}/pull/${number}`,
    head: { ref: `${key.toLowerCase()}-make-it-so`, sha: `c${number}` },
    base: { ref: base },
    created_at: "2026-01-01T09:00:00Z",
    updated_at: "2026-01-01T09:00:00Z",
  });

  /** Opens Pull Request #number naming the Ticket, its one check green (or running with null), GitHub saying it is mergeable. */
  const open = async (key: string, number: number, { repository = cronker, base = "main", check = "success" as string | null } = {}) => {
    const pullRequest = pullRequestOf(number, key, repository, base);
    await deliver(repository, "pull_request", { action: "opened", pull_request: pullRequest });
    if (check !== null) {
      await deliver(repository, "check_run", {
        action: "completed",
        check_run: { id: number, name: "test", head_sha: pullRequest.head.sha, status: "completed", conclusion: check, html_url: null },
      });
    } else {
      await deliver(repository, "check_run", {
        action: "created",
        check_run: { id: number, name: "test", head_sha: pullRequest.head.sha, status: "in_progress", conclusion: null, html_url: null },
      });
    }
    const onGitHub = cronk.github.pullRequest(repository, number, { headSha: pullRequest.head.sha, mergeable: true, base });
    return { pullRequest, onGitHub, repository, number };
  };

  /** A Ticket in In Review whose Pull Request is open, its one check green and GitHub saying it is mergeable. */
  const inReview = async (options: { repository?: typeof cronker; base?: string; check?: string | null } = {}) => {
    const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Make it so" });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("In Review") });
    return { ticket, ...(await open(ticket.key, Number(ticket.key.split("-")[1]) + 100, options)) };
  };
  /**
   * Like `inReview`, but the Pull Request opens while an Implement Run of claude-max, on Ada's fake Runner, works on the
   * Ticket, so Implement produced it; Ada then moves the Ticket to In Review herself.
   */
  let agent: { id: string } | undefined;
  const produced = async (options: Parameters<typeof inReview>[0] = {}) => {
    if (!agent) {
      const runner = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
      const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
      agent = await ok("PATCH", `/api/agents/${created.id}`, ada, { runnerId: runner.id });
    }
    const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Make it so" });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent!.id, autonomousDelegation: false, statusId: status("Implement") });
    const repository = options.repository ?? cronker;
    const number = Number(ticket.key.split("-")[1]) + 100;
    const pullRequest = pullRequestOf(number, ticket.key, repository, options.base);
    await deliver(repository, "pull_request", { action: "opened", pull_request: pullRequest });
    await deliver(repository, "check_run", {
      action: "completed",
      check_run: { id: number, name: "test", head_sha: pullRequest.head.sha, status: "completed", conclusion: "success", html_url: null },
    });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("In Review") });
    const onGitHub = cronk.github.pullRequest(repository, number, { headSha: pullRequest.head.sha, mergeable: true, base: options.base ?? "main" });
    return { ticket, pullRequest, onGitHub, repository, number };
  };
  const failCheck = (repository: typeof cronker, number: number, sha: string) =>
    deliver(repository, "check_run", {
      action: "completed",
      check_run: { id: 900 + number, name: "lint", head_sha: sha, status: "completed", conclusion: "failure", html_url: null },
    });
  const merge = (ticketId: string, as: As = ada) => call("POST", `/api/tickets/${ticketId}/merge`, as);
  const read = (ticketId: string) => ok("GET", `/api/tickets/${ticketId}`, ada);
  const cronkComments = async (ticketId: string) =>
    ((await ok("GET", `/api/tickets/${ticketId}/comments`, ada)) as { actor: { kind: string }; body: string }[])
      .filter((c) => c.actor.kind === "cronk")
      .map((c) => c.body);
  const runs = async (ticketId: string) =>
    ((await ok("GET", `/api/tickets/${ticketId}/runs`, ada)) as { step: { name: string } }[]).map((r) => r.step.name);
  return {
    workspace, user, ada, project, status, app, installation, cronker, website, deliver, open, inReview, produced, failCheck,
    merge, read, cronkComments, runs, agentOf: () => agent!,
  };
}

describe("Merge queues a Ticket", () => {
  test("moves it into Merge as the User's move, its Pull Request first in its queue, and the timeline shows it joining", async () => {
    const { ada, inReview, merge, status, user } = await queueSetting();
    const { ticket } = await inReview();

    const merged = await merge(ticket.id);

    expect(merged.status).toBe(200);
    expect(merged.json).toMatchObject({ statusId: status("Merge"), queue: { position: 1, state: "queued", pullRequestId: 601 } });
    const timeline = await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada);
    expect(timeline.slice(-2).map(({ actor, field, from, to }: Record<string, unknown>) => ({ actor, field, from, to }))).toEqual([
      {
        actor: expect.objectContaining({ kind: "user", id: user.id }),
        field: "queueJoined",
        from: null,
        to: { pullRequest: { id: 601, repository: "cronkcorp/cronker", number: 101, url: "https://github.com/cronkcorp/cronker/pull/101" } },
      },
      {
        actor: expect.objectContaining({ kind: "user", id: user.id }),
        field: "status",
        from: { id: status("In Review"), name: "In Review" },
        to: { id: status("Merge"), name: "Merge" },
      },
    ]);
  });

  test("the board lists the Merge column in queue order, whatever the keys", async () => {
    const { ada, project, inReview, merge, status } = await queueSetting();
    const [first, second, third] = [await inReview(), await inReview(), await inReview()];

    await ok("POST", `/api/tickets/${third.ticket.id}/merge`, ada);
    await ok("POST", `/api/tickets/${first.ticket.id}/merge`, ada);
    await merge(second.ticket.id);

    const board = await ok("GET", `/api/projects/${project.id}/tickets?statusId=${status("Merge")}`, ada);
    expect(board.map((t: { key: string; queue: { position: number } }) => [t.key, t.queue.position])).toEqual([
      ["CRONK-3", 1],
      ["CRONK-1", 2],
      ["CRONK-2", 3],
    ]);
  });

  test("a delegated Ticket a User queued gets no Merge Run, and isn't passed on to In Review", async () => {
    const { workspace, ada, project, inReview, merge, status, read } = await queueSetting();
    await ok("PATCH", `/api/projects/${project.id}`, ada, { agentsMayMerge: true });
    const runner = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
    const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
    const agent = await ok("PATCH", `/api/agents/${created.id}`, ada, { runnerId: runner.id });
    const autonomous = await inReview();
    const supervised = await inReview();
    await ok("PATCH", `/api/tickets/${autonomous.ticket.id}`, ada, { delegateId: agent.id, autonomousDelegation: true });
    await ok("PATCH", `/api/tickets/${supervised.ticket.id}`, ada, { delegateId: agent.id, autonomousDelegation: false });

    await merge(autonomous.ticket.id);
    await merge(supervised.ticket.id);

    for (const { ticket } of [autonomous, supervised]) {
      expect(await read(ticket.id)).toMatchObject({ statusId: status("Merge"), queue: { state: "queued" } });
      expect(await ok("GET", `/api/tickets/${ticket.id}/runs`, ada)).toEqual([]);
    }
    expect(cronk.runner.starts).toEqual([]);
  });

  test("needs Write in the Project", async () => {
    const { workspace, ada, project, inReview, merge, read, status } = await queueSetting();
    const grace = await addMember(cronk, ada.cookie, workspace.id, "grace@example.com");
    await ok("PUT", `/api/projects/${project.id}/access`, ada, { visibility: "private", users: [{ userId: grace.user.id, level: "read" }] });
    const { ticket } = await inReview();

    const refused = await merge(ticket.id, { cookie: grace.cookie });

    expect(refused.status).toBe(403);
    expect(refused.json).toMatchObject({ error: { code: "read_access" } });
    expect(await read(ticket.id)).toMatchObject({ statusId: status("In Review"), queue: null });
  });

  test("is refused, naming the rule, outside a Review Status", async () => {
    const { inReview, merge, ada, status, read } = await queueSetting();
    const { ticket } = await inReview();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Implement") });

    const refused = await merge(ticket.id);

    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ error: { code: "not_in_review", rule: expect.stringContaining("Review Status") } });
    expect(await read(ticket.id)).toMatchObject({ statusId: status("Implement"), queue: null });
  });

  test("is refused without an open linked Pull Request, a draft or closed one included", async () => {
    const { ada, project, status, merge, inReview, deliver, cronker } = await queueSetting();
    const bare = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "No code" });
    await ok("PATCH", `/api/tickets/${bare.id}`, ada, { statusId: status("In Review") });
    const draft = await inReview();
    await deliver(cronker, "pull_request", {
      action: "converted_to_draft",
      pull_request: { ...draft.pullRequest, draft: true, updated_at: "2026-01-01T09:01:00Z" },
    });

    for (const ticket of [bare, draft.ticket]) {
      const refused = await merge(ticket.id);
      expect(refused.status).toBe(409);
      expect(refused.json).toMatchObject({ error: { code: "no_open_pull_request", rule: expect.any(String) } });
    }
  });

  test("is refused with Pull Request automation off", async () => {
    const { ada, project, inReview, merge } = await queueSetting();
    const { ticket } = await inReview();
    await ok("PATCH", `/api/projects/${project.id}`, ada, { pullRequestAutomation: false });

    const refused = await merge(ticket.id);

    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ error: { code: "pull_request_automation_off", rule: expect.any(String) } });
  });

  test("is refused in a Project without a Merge Status", async () => {
    const { ada, project, inReview, merge, status } = await queueSetting();
    const { ticket } = await inReview();
    const removed = await call("DELETE", `/api/projects/${project.id}/statuses/${status("Merge")}/step`, ada);
    expect(removed.status, JSON.stringify(removed.json)).toBeLessThan(300);

    const refused = await merge(ticket.id);

    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ error: { code: "no_merge_status", rule: expect.any(String) } });
  });
});

describe("the queue pass", () => {
  test("merges one head per queue per pass, the first queued first, as the queuing User's, completing it as Verified", async () => {
    const { ada, inReview, merge, read, status, installation, user } = await queueSetting();
    const first = await inReview();
    const second = await inReview();
    await merge(second.ticket.id);
    await merge(first.ticket.id);

    await cronk.checkQueue();

    expect(cronk.github.merges).toEqual([
      { repository: "cronkcorp/cronker", number: 102, method: "merge", sha: "c102", installationId: installation.id },
    ]);
    expect(await read(second.ticket.id)).toMatchObject({ statusId: status("Done"), verification: "verified", queue: null });
    expect(await read(first.ticket.id)).toMatchObject({ statusId: status("Merge"), queue: { position: 1, state: "queued" } });
    const timeline = await ok("GET", `/api/tickets/${second.ticket.id}/timeline`, ada);
    expect(timeline.slice(-3).map(({ actor, field }: Record<string, unknown>) => [actor, field])).toEqual([
      [expect.objectContaining({ kind: "user", id: user.id }), "merged"],
      [expect.objectContaining({ kind: "user", id: user.id }), "status"],
      [expect.objectContaining({ kind: "user", id: user.id }), "verification"],
    ]);

    await cronk.checkQueue();

    expect(cronk.github.merges.map((m) => m.number)).toEqual([102, 101]);
    expect(await read(first.ticket.id)).toMatchObject({ statusId: status("Done"), verification: "verified" });
  });

  test("Tickets on another base branch or Repository don't wait on a queue", async () => {
    const { inReview, merge, website } = await queueSetting();
    const onMain = [await inReview(), await inReview()];
    const onRelease = await inReview({ base: "release" });
    const onWebsite = await inReview({ repository: website });
    for (const { ticket } of [...onMain, onRelease, onWebsite]) await merge(ticket.id);

    await cronk.checkQueue();

    expect(cronk.github.merges.map((m) => `${m.repository}#${m.number}`).sort()).toEqual([
      "cronkcorp/cronker#101",
      "cronkcorp/cronker#103",
      "cronkcorp/website#104",
    ]);
  });

  test("a head whose checks are still running waits, and so does the queue behind it", async () => {
    const { inReview, merge, read, status, deliver, cronker } = await queueSetting();
    const pending = await inReview({ check: null });
    const behind = await inReview();
    await merge(pending.ticket.id);
    await merge(behind.ticket.id);

    await cronk.checkQueue();

    expect(cronk.github.merges).toEqual([]);
    expect(await read(pending.ticket.id)).toMatchObject({ statusId: status("Merge"), queue: { position: 1, state: "queued" } });

    await deliver(cronker, "check_run", {
      action: "completed",
      check_run: { id: pending.number, name: "test", head_sha: pending.pullRequest.head.sha, status: "completed", conclusion: "success", html_url: null },
    });

    // The delivery has the queue act on its head at once, without waiting for the next pass.
    expect(cronk.github.merges.map((m) => m.number)).toEqual([101]);
  });

  test("a head GitHub says isn't mergeable yet waits", async () => {
    const { inReview, merge, read, status } = await queueSetting();
    const { ticket, onGitHub } = await inReview();
    onGitHub.mergeable = null;
    await merge(ticket.id);

    await cronk.checkQueue();

    expect(cronk.github.merges).toEqual([]);
    expect(await read(ticket.id)).toMatchObject({ statusId: status("Merge"), queue: { position: 1, state: "queued" } });

    onGitHub.mergeable = true;
    await cronk.checkQueue();

    expect(await read(ticket.id)).toMatchObject({ statusId: status("Done"), verification: "verified" });
  });
});

describe("leaving the queue", () => {
  test("Remove from queue sends the Ticket back to In Review, the next one moving up", async () => {
    const { ada, inReview, merge, read, status, user } = await queueSetting();
    const first = await inReview();
    const second = await inReview();
    await merge(first.ticket.id);
    await merge(second.ticket.id);

    const removed = await call("POST", `/api/tickets/${first.ticket.id}/queue/remove`, ada);

    expect(removed.status).toBe(200);
    expect(removed.json).toMatchObject({ statusId: status("In Review"), queue: null });
    expect(await read(second.ticket.id)).toMatchObject({ queue: { position: 1 } });
    const timeline = await ok("GET", `/api/tickets/${first.ticket.id}/timeline`, ada);
    expect(timeline.slice(-2).map(({ actor, field, from, to }: Record<string, unknown>) => ({ actor, field, from, to }))).toEqual([
      {
        actor: expect.objectContaining({ kind: "user", id: user.id }),
        field: "queueLeft",
        from: { pullRequest: { id: 601, repository: "cronkcorp/cronker", number: 101, url: "https://github.com/cronkcorp/cronker/pull/101" } },
        to: null,
      },
      expect.objectContaining({ field: "status", to: { id: status("In Review"), name: "In Review" } }),
    ]);

    await cronk.checkQueue();
    expect(cronk.github.merges.map((m) => m.number)).toEqual([102]);
  });

  test("Remove from queue is refused for a Ticket not in the queue", async () => {
    const { ada, inReview } = await queueSetting();
    const { ticket } = await inReview();

    const refused = await call("POST", `/api/tickets/${ticket.id}/queue/remove`, ada);

    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ error: { code: "not_queued" } });
  });

  test("moving a queued Ticket out of Merge takes it out of the queue", async () => {
    const { ada, inReview, merge, read, status } = await queueSetting();
    const { ticket } = await inReview();
    await merge(ticket.id);

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Implement") });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Merge") });
    await cronk.checkQueue();

    expect(cronk.github.merges).toEqual([]);
    expect(await read(ticket.id)).toMatchObject({ queue: null });
  });

  test("a merge on GitHub takes the Pull Request out of the queue and completes the Ticket as today", async () => {
    const { inReview, merge, read, status, deliver, cronker } = await queueSetting();
    const first = await inReview();
    const second = await inReview();
    await merge(first.ticket.id);
    await merge(second.ticket.id);

    await deliver(cronker, "pull_request", {
      action: "closed",
      pull_request: {
        ...first.pullRequest,
        state: "closed",
        merged: true,
        merged_by: { login: "someone-else", id: 9999 },
        merge_commit_sha: "m101",
        updated_at: "2026-01-01T09:05:00Z",
      },
    });

    expect(await read(first.ticket.id)).toMatchObject({ statusId: status("Done"), verification: "unverified", queue: null });
    expect(await read(second.ticket.id)).toMatchObject({ queue: { position: 1 } });
    await cronk.checkQueue();
    expect(cronk.github.merges.map((m) => m.number)).toEqual([102]);
  });

  test("a Pull Request closed on GitHub leaves the queue, the timeline saying so", async () => {
    const { ada, inReview, merge, read, deliver, cronker } = await queueSetting();
    const { ticket, pullRequest } = await inReview();
    await merge(ticket.id);

    await deliver(cronker, "pull_request", {
      action: "closed",
      pull_request: { ...pullRequest, state: "closed", updated_at: "2026-01-01T09:05:00Z" },
    });

    expect(await read(ticket.id)).toMatchObject({ queue: null });
    const timeline = await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada);
    expect(timeline.at(-1)).toMatchObject({ actor: { kind: "cronk" }, field: "queueLeft", to: null });
    await cronk.checkQueue();
    expect(cronk.github.merges).toEqual([]);
  });
});

describe("a Ticket with several Pull Requests", () => {
  /**
   * CRONK-1 in the queue for cronker's main first, then CRONK-2 with #102 on cronker's main, #201 on website's main and
   * #202 on cronker's release, each green and mergeable.
   */
  async function severalSetting() {
    const setting = await queueSetting();
    const { inReview, open, website } = setting;
    const ahead = await inReview();
    const several = await inReview();
    const onWebsite = await open(several.ticket.key, 201, { repository: website });
    const onRelease = await open(several.ticket.key, 202, { base: "release" });
    await setting.merge(ahead.ticket.id);
    return { ...setting, ahead, several, onWebsite, onRelease };
  }
  const fields = (timeline: Record<string, unknown>[]) => timeline.map((change) => change.field);
  const mergedNumbers = (timeline: { field: string; to: { pullRequest: { number: number } } }[]) =>
    timeline.filter((change) => change.field === "merged").map((change) => change.to.pullRequest.number);

  test("each open linked Pull Request joins its own Repository's and base branch's queue", async () => {
    const { ada, several, merge, status } = await severalSetting();

    const queued = await merge(several.ticket.id);

    expect(queued.status).toBe(200);
    expect(queued.json).toMatchObject({ statusId: status("Merge") });
    const timeline = await ok("GET", `/api/tickets/${several.ticket.id}/timeline`, ada);
    expect(
      timeline
        .filter((change: { field: string }) => change.field === "queueJoined")
        .map((change: { to: { pullRequest: { repository: string; number: number } } }) => `${change.to.pullRequest.repository}#${change.to.pullRequest.number}`)
        .sort(),
    ).toEqual(["cronkcorp/cronker#102", "cronkcorp/cronker#202", "cronkcorp/website#201"]);

    await cronk.checkQueue();

    // Three queues, three heads: CRONK-1's #101 holds cronker's main, so CRONK-2's #102 waits behind it.
    expect(cronk.github.merges.map((m) => `${m.repository}#${m.number}`).sort()).toEqual([
      "cronkcorp/cronker#101",
      "cronkcorp/cronker#202",
      "cronkcorp/website#201",
    ]);
  });

  test("the first merge leaves the Ticket in Merge; the last completes it, Verified as the queuing User's", async () => {
    const { ada, several, merge, read, status, user } = await severalSetting();
    await merge(several.ticket.id);

    await cronk.checkQueue();

    expect(await read(several.ticket.id)).toMatchObject({
      statusId: status("Merge"),
      verification: null,
      queue: { pullRequestId: 602, position: 1, state: "queued" },
    });
    let timeline = await ok("GET", `/api/tickets/${several.ticket.id}/timeline`, ada);
    expect(fields(timeline)).not.toContain("queueLeft");
    expect(mergedNumbers(timeline).sort()).toEqual([201, 202]);
    expect(fields(timeline.slice(-2))).toEqual(["merged", "merged"]);
    expect(await ok("GET", `/api/tickets/${several.ticket.id}/runs`, ada)).toEqual([]);

    await cronk.checkQueue();

    expect(cronk.github.merges.at(-1)).toMatchObject({ repository: "cronkcorp/cronker", number: 102 });
    expect(await read(several.ticket.id)).toMatchObject({ statusId: status("Done"), verification: "verified", queue: null });
    timeline = await ok("GET", `/api/tickets/${several.ticket.id}/timeline`, ada);
    expect(fields(timeline)).not.toContain("queueLeft");
    expect(timeline.slice(-3).map(({ actor, field }: Record<string, unknown>) => [actor, field])).toEqual([
      [expect.objectContaining({ kind: "user", id: user.id }), "merged"],
      [expect.objectContaining({ kind: "user", id: user.id }), "status"],
      [expect.objectContaining({ kind: "user", id: user.id }), "verification"],
    ]);
  });

  test("GitHub's delivery of a queued merge arriving before its answer still waits for the other Pull Requests", async () => {
    const { several, merge, read, status, deliver, website, onWebsite } = await severalSetting();
    await merge(several.ticket.id);
    cronk.github.onMerge = async (merged) => {
      if (merged.number !== 201) return;
      await deliver(website, "pull_request", {
        action: "closed",
        pull_request: {
          ...onWebsite.pullRequest,
          state: "closed",
          merged: true,
          merged_by: { login: "cronk-app[bot]", id: 4242 },
          merge_commit_sha: "m201",
          updated_at: "2026-01-01T09:05:00Z",
        },
      });
    };

    await cronk.checkQueue();

    expect(await read(several.ticket.id)).toMatchObject({ statusId: status("Merge"), queue: { pullRequestId: 602 } });
  });

  test("one Pull Request sending it back takes all of its entries out, the merges before it kept", async () => {
    const { ada, several, merge, read, status, failCheck, cronker } = await severalSetting();
    await merge(several.ticket.id);
    await cronk.checkQueue();

    // #102 still waits behind CRONK-1 when its check fails; no Step produced it, so it goes back to In Review.
    await failCheck(cronker, several.number, several.pullRequest.head.sha);

    expect(await read(several.ticket.id)).toMatchObject({ statusId: status("In Review"), queue: null });
    const timeline = await ok("GET", `/api/tickets/${several.ticket.id}/timeline`, ada);
    expect(mergedNumbers(timeline).sort()).toEqual([201, 202]);
    expect(
      timeline.filter((change: { field: string }) => change.field === "queueLeft").map((change: { from: { pullRequest: { number: number } } }) => change.from.pullRequest.number),
    ).toEqual([102]);
    await cronk.checkQueue();
    expect(cronk.github.merges.map((m) => m.number).sort()).toEqual([101, 201, 202]);
  });

  test("a merge on GitHub outside the queue completes the Ticket on its first merge, clearing the rest", async () => {
    const { ada, several, merge, read, status, deliver, website, onWebsite } = await severalSetting();
    await merge(several.ticket.id);

    await deliver(website, "pull_request", {
      action: "closed",
      pull_request: {
        ...onWebsite.pullRequest,
        state: "closed",
        merged: true,
        merged_by: { login: "someone-else", id: 9999 },
        merge_commit_sha: "m201",
        updated_at: "2026-01-01T09:05:00Z",
      },
    });

    expect(await read(several.ticket.id)).toMatchObject({ statusId: status("Done"), verification: "unverified", queue: null });
    const timeline = await ok("GET", `/api/tickets/${several.ticket.id}/timeline`, ada);
    expect(fields(timeline)).not.toContain("queueLeft");
    await cronk.checkQueue();
    expect(cronk.github.merges.map((m) => m.number)).toEqual([101]);
  });
});

describe("failures leaving the queue", () => {
  test("a failing check on the head sends it back to the Step that produced it as a round, with Cronk's Comment, and the queue moves on", async () => {
    const { inReview, produced, failCheck, merge, read, status, cronker, cronkComments, runs } = await queueSetting();
    const head = await produced();
    const next = await inReview();
    await merge(head.ticket.id);
    await merge(next.ticket.id);
    expect(await runs(head.ticket.id)).toEqual(["Implement"]);

    await failCheck(cronker, head.number, head.pullRequest.head.sha);

    expect(await read(head.ticket.id)).toMatchObject({ statusId: status("Implement"), queue: null });
    expect(await cronkComments(head.ticket.id)).toEqual([
      "The check **lint** failed on [cronkcorp/cronker#101](https://github.com/cronkcorp/cronker/pull/101)'s latest commit `c101`. Sent CRONK-1 back to Implement.",
    ]);
    // Sent back as a round, starting the next Implement Run.
    expect(await runs(head.ticket.id)).toEqual(["Implement", "Implement"]);
    expect(await read(next.ticket.id)).toMatchObject({ queue: { position: 1 } });

    await cronk.checkQueue();

    expect(cronk.github.merges.map((m) => m.number)).toEqual([102]);
  });

  test("changes requested on a waiting Ticket take it out of the queue, the head still merging", async () => {
    const { inReview, produced, merge, read, status, deliver, cronker, cronkComments } = await queueSetting();
    const head = await inReview();
    const waiting = await produced();
    await merge(head.ticket.id);
    await merge(waiting.ticket.id);

    await deliver(cronker, "pull_request_review", {
      action: "submitted",
      review: { id: 71, state: "changes_requested", html_url: null, user: { login: "bea" } },
      pull_request: { id: waiting.pullRequest.id },
    });

    expect(await read(waiting.ticket.id)).toMatchObject({ statusId: status("Implement"), queue: null });
    expect(await cronkComments(waiting.ticket.id)).toEqual([
      "@bea requested changes on [cronkcorp/cronker#102](https://github.com/cronkcorp/cronker/pull/102). Sent CRONK-2 back to Implement.",
    ]);
    await cronk.checkQueue();
    expect(cronk.github.merges.map((m) => m.number)).toEqual([101]);
  });

  test("a queued Ticket no Step produced goes back to In Review, not as a round, the next one merging", async () => {
    const { ada, inReview, merge, read, status, cronkComments, runs } = await queueSetting();
    // A User opened its Pull Request, so its failing check sent nothing back while it waited in In Review.
    const failing = await inReview({ check: "failure" });
    const next = await inReview();
    expect(await read(failing.ticket.id)).toMatchObject({ statusId: status("In Review") });
    await merge(failing.ticket.id);
    await merge(next.ticket.id);

    await cronk.checkQueue();

    expect(cronk.github.merges).toEqual([]);
    expect(await read(failing.ticket.id)).toMatchObject({ statusId: status("In Review"), queue: null });
    expect(await cronkComments(failing.ticket.id)).toEqual([
      "The check **test** failed on [cronkcorp/cronker#101](https://github.com/cronkcorp/cronker/pull/101)'s latest commit `c101`. Sent CRONK-1 back to In Review.",
    ]);
    expect(await runs(failing.ticket.id)).toEqual([]);
    const timeline = await ok("GET", `/api/tickets/${failing.ticket.id}/timeline`, ada);
    expect(timeline.slice(-3).map(({ actor, field }: Record<string, unknown>) => [(actor as { kind: string }).kind, field])).toEqual([
      ["cronk", "sentBack"],
      ["cronk", "queueLeft"],
      ["cronk", "status"],
    ]);

    await cronk.checkQueue();

    expect(cronk.github.merges.map((m) => m.number)).toEqual([102]);
  });

  test("a Ticket queued again on the commit that sent it back is sent back again by the pass", async () => {
    const { ada, produced, failCheck, merge, read, status, cronker, cronkComments } = await queueSetting();
    const { ticket, number, pullRequest } = await produced();
    await failCheck(cronker, number, pullRequest.head.sha);
    expect(await read(ticket.id)).toMatchObject({ statusId: status("Implement") });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("In Review") });
    await merge(ticket.id);

    await cronk.checkQueue();

    expect(cronk.github.merges).toEqual([]);
    expect(await read(ticket.id)).toMatchObject({ statusId: status("Implement"), queue: null });
    expect(await cronkComments(ticket.id)).toHaveLength(2);
  });

  test("a merge GitHub refuses hands the Ticket to its Assignee with GitHub's reason, and the queue moves on", async () => {
    const { workspace, user, ada, inReview, merge, read, status, cronker, runs } = await queueSetting();
    const refused = await inReview();
    await ok("PATCH", `/api/tickets/${refused.ticket.id}`, ada, { assigneeId: user.id });
    const next = await inReview();
    await merge(refused.ticket.id);
    await merge(next.ticket.id);
    cronker.mergeMethods = { merge: false, squash: false, rebase: false };

    await cronk.checkQueue();

    expect(cronk.github.merges).toEqual([]);
    expect(await read(refused.ticket.id)).toMatchObject({ statusId: status("In Review"), queue: null });
    expect(await runs(refused.ticket.id)).toEqual([]);
    const { items } = await ok("GET", `/api/workspaces/${workspace.id}/inbox`, ada);
    expect(items.filter((i: { kind: string }) => i.kind === "needsYou")).toEqual([
      expect.objectContaining({
        ticket: expect.objectContaining({ key: "CRONK-1" }),
        outcome: "needs you",
        step: { statusId: status("Merge"), name: "Merge" },
        question: expect.stringContaining(
          "GitHub refused to merge cronkcorp/cronker#101: “Merge commits are not allowed on this repository.”, so CRONK-1 left the Merge Queue.",
        ),
      }),
    ]);
    expect(await read(next.ticket.id)).toMatchObject({ queue: { position: 1 } });

    cronker.mergeMethods = { merge: true, squash: true, rebase: true };
    await cronk.checkQueue();

    expect(cronk.github.merges.map((m) => m.number)).toEqual([102]);
  });
});

describe("a head behind its base branch", () => {
  /**
   * CRONK-1's Pull Request #101 queued first, GitHub saying it is behind `main` though it merges cleanly, and CRONK-2's
   * #102 queued behind it. `pushed` delivers the push GitHub's branch update made to #101, and `check` a check on it.
   */
  async function behindSetting() {
    const setting = await queueSetting();
    const { inReview, merge, deliver, cronker } = setting;
    const head = await inReview();
    head.onGitHub.behind = true;
    const next = await inReview();
    await merge(head.ticket.id);
    await merge(next.ticket.id);
    const pushed = (sha: string) =>
      deliver(cronker, "pull_request", {
        action: "synchronize",
        pull_request: { ...head.pullRequest, head: { ...head.pullRequest.head, sha }, updated_at: "2026-01-01T09:10:00Z" },
      });
    const check = (sha: string, conclusion: "success" | null) =>
      deliver(cronker, "check_run", {
        action: conclusion === null ? "created" : "completed",
        check_run: {
          id: 1000,
          name: "test",
          head_sha: sha,
          status: conclusion === null ? "in_progress" : "completed",
          conclusion,
          html_url: null,
        },
      });
    return { ...setting, head, next, pushed, check };
  }

  test("is updated, not merged, showing Updating branch, then Waiting for checks, the Tickets behind it waiting", async () => {
    const { head, next, read, status, installation } = await behindSetting();
    const seen: unknown[] = [];
    cronk.github.onUpdate = async () => {
      seen.push((await read(head.ticket.id)).queue?.state);
    };

    await cronk.checkQueue();

    expect(cronk.github.merges).toEqual([]);
    expect(cronk.github.updates).toEqual([
      { repository: "cronkcorp/cronker", number: 101, from: "c101", to: "c101u1", installationId: installation.id },
    ]);
    expect(seen).toEqual(["updating-branch"]);
    expect(await read(head.ticket.id)).toMatchObject({ statusId: status("Merge"), queue: { position: 1, state: "waiting-for-checks" } });
    expect(await read(next.ticket.id)).toMatchObject({ queue: { position: 2, state: "queued" } });

    // Until GitHub reports the new commit, the old one's green checks don't count.
    await cronk.checkQueue();
    expect(cronk.github.merges).toEqual([]);
    expect(cronk.github.updates).toHaveLength(1);
  });

  test("merges on the next pass once the new commit's checks are green, waiting while they are pending", async () => {
    const { head, next, read, status, pushed, check } = await behindSetting();
    await cronk.checkQueue();

    await pushed("c101u1");
    await cronk.checkQueue();
    // No check reported on the new commit yet, though the old one had one.
    expect(cronk.github.merges).toEqual([]);

    await check("c101u1", null);
    await cronk.checkQueue();
    expect(cronk.github.merges).toEqual([]);
    expect(await read(head.ticket.id)).toMatchObject({ queue: { position: 1, state: "waiting-for-checks" } });
    expect(await read(next.ticket.id)).toMatchObject({ queue: { position: 2, state: "queued" } });

    await check("c101u1", "success");
    await cronk.checkQueue();

    expect(cronk.github.merges.map(({ number, sha }) => [number, sha])).toEqual([
      [101, "c101u1"],
      [102, "c102"],
    ]);
    expect(await read(head.ticket.id)).toMatchObject({ statusId: status("Done"), verification: "verified", queue: null });
  });

  test("a green check delivered on the new commit has it merge at once", async () => {
    const { head, read, status, pushed, check } = await behindSetting();
    await cronk.checkQueue();
    await pushed("c101u1");

    await check("c101u1", "success");

    expect(cronk.github.merges.map((m) => m.number)).toEqual([101]);
    expect(await read(head.ticket.id)).toMatchObject({ statusId: status("Done") });
  });

  test("a failing check on the updated commit takes it out of the queue, and the next one moves up", async () => {
    const { head, next, read, status, pushed, deliver, cronker } = await behindSetting();
    await cronk.checkQueue();
    await pushed("c101u1");

    await deliver(cronker, "check_run", {
      action: "completed",
      check_run: { id: 1000, name: "test", head_sha: "c101u1", status: "completed", conclusion: "failure", html_url: null },
    });

    expect(await read(head.ticket.id)).toMatchObject({ statusId: status("In Review"), queue: null });
    expect(await read(next.ticket.id)).toMatchObject({ queue: { position: 1 } });
    await cronk.checkQueue();
    expect(cronk.github.merges.map((m) => m.number)).toEqual([102]);
  });

  test("a head GitHub won't update, as when updating it conflicts, waits in the queue for a later pass", async () => {
    const { head, read } = await behindSetting();
    head.onGitHub.mergeable = false;
    head.onGitHub.answers = [true];

    await cronk.checkQueue();

    expect(cronk.github.updates).toEqual([]);
    expect(cronk.github.merges).toEqual([]);
    expect(await read(head.ticket.id)).toMatchObject({ queue: { position: 1, state: "queued" } });
  });

  test("a queue on another base branch doesn't wait on a head being updated", async () => {
    const { inReview, merge } = await behindSetting();
    const other = await inReview({ base: "release" });
    await merge(other.ticket.id);

    await cronk.checkQueue();

    expect(cronk.github.updates.map((u) => u.number)).toEqual([101]);
    expect(cronk.github.merges.map((m) => m.number)).toEqual([other.number]);
  });
});

describe("deliveries for a queued Pull Request", () => {
  test("a status, check suite or review delivery has the queue act on it at once", async () => {
    const { inReview, merge, deliver, cronker } = await queueSetting();
    const byStatus = await inReview();
    const bySuite = await inReview({ base: "release" });
    const byReview = await inReview({ base: "next" });
    const other = await inReview({ base: "other" });
    for (const { ticket } of [byStatus, bySuite, byReview, other]) await merge(ticket.id);
    const merged = () => cronk.github.merges.map((m) => m.number);

    await deliver(cronker, "status", { id: 1, sha: byStatus.pullRequest.head.sha, context: "lint", state: "success", target_url: null });
    expect(merged()).toEqual([byStatus.number]);

    await deliver(cronker, "check_suite", {
      action: "completed",
      check_suite: { id: 7, head_sha: bySuite.pullRequest.head.sha, conclusion: "success", app: { name: "CI" }, updated_at: "2026-01-01T09:00:00Z" },
    });
    expect(merged()).toEqual([byStatus.number, bySuite.number]);

    await deliver(cronker, "pull_request_review", {
      action: "submitted",
      review: { id: 9, state: "approved", html_url: null, user: { login: "grace" } },
      pull_request: { id: byReview.pullRequest.id },
    });
    // Only the Pull Request delivered about, not the other queue's head.
    expect(merged()).toEqual([byStatus.number, bySuite.number, byReview.number]);
  });
});

describe("Autonomous Delegation joins the queue", () => {
  /**
   * `queueSetting` with agents may merge on and Ada's Agent claude-max on her fake Runner, with a Write token.
   * `approved()` takes a Ticket `inReview` makes, delegates it with Autonomous Delegation into Code review, and has its
   * Code review Run approve it, moving it into Merge.
   */
  async function autonomousSetting() {
    const setting = await queueSetting();
    const { workspace, ada, project, inReview, status } = setting;
    await ok("PATCH", `/api/projects/${project.id}`, ada, { agentsMayMerge: true });
    const runner = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
    const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
    const agent = await ok("PATCH", `/api/agents/${created.id}`, ada, { runnerId: runner.id });
    const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "cloud", access: "write" });
    const asAgent = { headers: { authorization: `Bearer ${secret}` } };
    const approved = async () => {
      const made = await inReview();
      await ok("PATCH", `/api/tickets/${made.ticket.id}`, ada, {
        delegateId: agent.id,
        autonomousDelegation: true,
        statusId: status("Code review"),
      });
      const runs = await ok("GET", `/api/tickets/${made.ticket.id}/runs`, ada);
      const running = runs.find((r: { state: string }) => r.state === "running");
      await ok("POST", `/api/runs/${running.id}/finish`, asAgent, { outcome: "approve" });
      return made;
    };
    return { ...setting, agent, asAgent, approved };
  }

  const runsIn = async (ticketId: string, as: As, step: string) =>
    (await ok("GET", `/api/tickets/${ticketId}/runs`, as)).filter((r: { step: { name: string } }) => r.step.name === step);

  test("entering Merge from Code review, it joins the queue as Cronk's Change and gets no Merge Run", async () => {
    const { ada, approved, read, status } = await autonomousSetting();

    const { ticket } = await approved();

    expect(await read(ticket.id)).toMatchObject({ statusId: status("Merge"), queue: { position: 1, state: "queued", pullRequestId: 601 } });
    expect(await runsIn(ticket.id, ada, "Merge")).toEqual([]);
    expect(cronk.runner.starts.map((s) => s.model)).toEqual(["sonnet"]);
    const timeline = await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada);
    expect(timeline.find((c: { field: string }) => c.field === "queueJoined")).toMatchObject({
      actor: { kind: "cronk" },
      to: { pullRequest: { id: 601, repository: "cronkcorp/cronker", number: 101, url: "https://github.com/cronkcorp/cronker/pull/101" } },
    });
  });

  test("Cronk merges it as the Agent's, with no Run, completing it as Unverified into its Assignee's Inbox", async () => {
    const { ada, approved, read, status, agent, workspace, installation } = await autonomousSetting();
    const { ticket } = await approved();

    await cronk.checkQueue();

    expect(cronk.github.merges).toEqual([
      { repository: "cronkcorp/cronker", number: 101, method: "merge", sha: "c101", installationId: installation.id },
    ]);
    expect(await read(ticket.id)).toMatchObject({ statusId: status("Done"), verification: "unverified", queue: null });
    const timeline = await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada);
    expect(timeline.slice(-3).map(({ actor, field, runId }: Record<string, unknown>) => [actor, field, runId])).toEqual([
      [expect.objectContaining({ kind: "agent", id: agent.id }), "merged", null],
      [expect.objectContaining({ kind: "agent", id: agent.id }), "status", null],
      [expect.objectContaining({ kind: "agent", id: agent.id }), "verification", null],
    ]);
    const { items } = await ok("GET", `/api/workspaces/${workspace.id}/inbox`, ada);
    expect(items.filter((i: { kind: string }) => i.kind === "unverified")).toEqual([
      expect.objectContaining({ ticket: expect.objectContaining({ key: ticket.key }) }),
    ]);
    expect(await runsIn(ticket.id, ada, "Merge")).toEqual([]);
  });

  test("it waits its turn behind a Ticket a User queued first, each completing as its queuer's", async () => {
    const { approved, inReview, merge, read, status } = await autonomousSetting();
    const byAda = await inReview();
    await merge(byAda.ticket.id);
    const { ticket } = await approved();

    await cronk.checkQueue();

    expect(cronk.github.merges.map((m) => m.number)).toEqual([101]);
    expect(await read(byAda.ticket.id)).toMatchObject({ statusId: status("Done"), verification: "verified" });
    expect(await read(ticket.id)).toMatchObject({ statusId: status("Merge"), queue: { position: 1 } });

    await cronk.checkQueue();

    expect(cronk.github.merges.map((m) => m.number)).toEqual([101, 102]);
    expect(await read(ticket.id)).toMatchObject({ statusId: status("Done"), verification: "unverified" });
  });

  test("with no open Pull Request to queue, such as a draft, it gets a Merge Run instead", async () => {
    const { ada, project, status, agent, asAgent, read, deliver, cronker } = await autonomousSetting();
    const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Make it so" });
    await deliver(cronker, "pull_request", {
      action: "opened",
      pull_request: {
        id: 601, number: 101, title: `${ticket.key}: make it so`, state: "open", draft: true, merged: false,
        html_url: "https://github.com/cronkcorp/cronker/pull/101", head: { ref: "cronk-1", sha: "c101" }, base: { ref: "main" },
        created_at: "2026-01-01T09:00:00Z", updated_at: "2026-01-01T09:00:00Z",
      },
    });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, autonomousDelegation: true, statusId: status("Code review") });
    const [review] = await runsIn(ticket.id, ada, "Code review");
    await ok("POST", `/api/runs/${review.id}/finish`, asAgent, { outcome: "approve" });

    expect(await read(ticket.id)).toMatchObject({ statusId: status("Merge"), queue: null });
    expect((await runsIn(ticket.id, ada, "Merge")).map((r: { state: string }) => r.state)).toEqual(["running"]);
  });

  test("turning agents may merge off passes the Tickets only it queued on to In Review, keeping those a User queued", async () => {
    const { ada, project, approved, inReview, merge, read, status, agent } = await autonomousSetting();
    const { ticket: autonomous } = await approved();
    const byAda = await inReview();
    await ok("PATCH", `/api/tickets/${byAda.ticket.id}`, ada, { delegateId: agent.id, autonomousDelegation: true });
    await merge(byAda.ticket.id);

    await ok("PATCH", `/api/projects/${project.id}`, ada, { agentsMayMerge: false });

    expect(await read(autonomous.id)).toMatchObject({ statusId: status("In Review"), queue: null });
    const timeline = await ok("GET", `/api/tickets/${autonomous.id}/timeline`, ada);
    expect(timeline.slice(-3).map(({ actor, field, to }: Record<string, unknown>) => [actor, field, to])).toEqual([
      [expect.objectContaining({ kind: "cronk" }), "queueLeft", null],
      [expect.objectContaining({ kind: "cronk" }), "stepSkipped", expect.objectContaining({ mergeRule: "agentsMayMergeOff" })],
      [expect.objectContaining({ kind: "cronk" }), "status", { id: status("In Review"), name: "In Review" }],
    ]);
    expect(await read(byAda.ticket.id)).toMatchObject({ statusId: status("Merge"), queue: { position: 1, state: "queued" } });
    expect(await runsIn(autonomous.id, ada, "Merge")).toEqual([]);

    await cronk.checkQueue();

    expect(cronk.github.merges.map((m) => m.number)).toEqual([102]);
    expect(await read(byAda.ticket.id)).toMatchObject({ statusId: status("Done"), verification: "verified" });
  });
});

describe("an Agent with a Full token", () => {
  /** `queueSetting` with Ada's Agent claude-max holding a Write and a Full token. */
  async function fullSetting() {
    const setting = await queueSetting();
    const { workspace, ada } = setting;
    const agent = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
    const bearer = async (access: string) => {
      const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: access, access });
      return { headers: { authorization: `Bearer ${secret}` } };
    };
    return { ...setting, agent, asWrite: await bearer("write"), asFull: await bearer("full") };
  }

  test("queues a Ticket as its Agent, and Cronk's merge completes it as Unverified, agents may merge being off", async () => {
    const { ada, inReview, merge, read, status, agent, asFull, workspace, user } = await fullSetting();
    const { ticket } = await inReview();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { assigneeId: user.id });

    const queued = await merge(ticket.id, asFull);

    expect(queued.status, JSON.stringify(queued.json)).toBe(200);
    expect(queued.json).toMatchObject({ statusId: status("Merge"), queue: { position: 1, state: "queued" } });
    const joined = await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada);
    expect(joined.slice(-2).map(({ actor, field, runId }: Record<string, unknown>) => [actor, field, runId])).toEqual([
      [expect.objectContaining({ kind: "agent", id: agent.id }), "queueJoined", null],
      [expect.objectContaining({ kind: "agent", id: agent.id }), "status", null],
    ]);

    await cronk.checkQueue();

    expect(cronk.github.merges.map((m) => m.number)).toEqual([101]);
    expect(await read(ticket.id)).toMatchObject({ statusId: status("Done"), verification: "unverified", queue: null });
    const timeline = await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada);
    expect(timeline.slice(-3).map(({ actor, field, runId }: Record<string, unknown>) => [actor, field, runId])).toEqual([
      [expect.objectContaining({ kind: "agent", id: agent.id }), "merged", null],
      [expect.objectContaining({ kind: "agent", id: agent.id }), "status", null],
      [expect.objectContaining({ kind: "agent", id: agent.id }), "verification", null],
    ]);
    const { items } = await ok("GET", `/api/workspaces/${workspace.id}/inbox`, ada);
    expect(items.filter((i: { kind: string }) => i.kind === "unverified")).toHaveLength(1);
  });

  test("its entry stays queued when agents may merge is turned off", async () => {
    const { ada, project, inReview, merge, read, status, asFull } = await fullSetting();
    await ok("PATCH", `/api/projects/${project.id}`, ada, { agentsMayMerge: true });
    const { ticket } = await inReview();
    await merge(ticket.id, asFull);

    await ok("PATCH", `/api/projects/${project.id}`, ada, { agentsMayMerge: false });

    expect(await read(ticket.id)).toMatchObject({ statusId: status("Merge"), queue: { position: 1, state: "queued" } });
    await cronk.checkQueue();
    expect(await read(ticket.id)).toMatchObject({ statusId: status("Done"), verification: "unverified" });
  });

  test("removes a Ticket from the queue, as its Agent's move", async () => {
    const { ada, inReview, merge, status, agent, asFull } = await fullSetting();
    const { ticket } = await inReview();
    await merge(ticket.id);

    const removed = await call("POST", `/api/tickets/${ticket.id}/queue/remove`, asFull);

    expect(removed.status, JSON.stringify(removed.json)).toBe(200);
    expect(removed.json).toMatchObject({ statusId: status("In Review"), queue: null });
    const timeline = await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada);
    expect(timeline.slice(-1)).toEqual([
      expect.objectContaining({ actor: expect.objectContaining({ kind: "agent", id: agent.id }), field: "status", runId: null }),
    ]);
  });

  test("a Write token is refused both with full_token_needed, and nothing changes", async () => {
    const { inReview, merge, read, status, asWrite } = await fullSetting();
    const { ticket } = await inReview();

    const queued = await merge(ticket.id, asWrite);
    expect([queued.status, queued.json.error.code]).toEqual([403, "full_token_needed"]);
    await merge(ticket.id);
    const removed = await call("POST", `/api/tickets/${ticket.id}/queue/remove`, asWrite);
    expect([removed.status, removed.json.error.code]).toEqual([403, "full_token_needed"]);
    expect(await read(ticket.id)).toMatchObject({ statusId: status("Merge"), queue: { position: 1 } });
  });
});

describe("a head conflicting with its base branch", () => {
  /**
   * Four Tickets Implement produced for claude-max, each queued by Ada in turn: CRONK-1's #101 merging makes CRONK-2's
   * #102 conflict with `main`. claude-max has a token, `finish` ends the Ticket's running Run as it, and `resolve` has
   * it push a resolution to #102 as `sha`, GitHub saying it merges cleanly again, then finish *resolved*.
   */
  async function conflictSetting() {
    const setting = await queueSetting();
    const { ada, produced, merge, deliver, cronker, agentOf } = setting;
    const tickets = [await produced(), await produced(), await produced(), await produced()];
    tickets[0]!.onGitHub.conflicts = [tickets[1]!.onGitHub];
    for (const { ticket } of tickets) await merge(ticket.id);
    const { secret } = await ok("POST", `/api/agents/${agentOf().id}/tokens`, ada, { name: "cloud", access: "write" });
    const asAgent = { headers: { authorization: `Bearer ${secret}` } };
    const running = async (ticketId: string) =>
      ((await ok("GET", `/api/tickets/${ticketId}/runs`, ada)) as { id: string; state: string; step: { name: string } }[]).find(
        (r) => r.state === "running",
      );
    const finish = async (ticketId: string, outcome: string, extra: Record<string, unknown> = {}) =>
      call("POST", `/api/runs/${(await running(ticketId))!.id}/finish`, asAgent, { outcome, ...extra });
    const [, conflicting] = tickets as [(typeof tickets)[0], (typeof tickets)[0]];
    const push = async (sha: string) => {
      await deliver(cronker, "pull_request", {
        action: "synchronize",
        pull_request: { ...conflicting.pullRequest, head: { ...conflicting.pullRequest.head, sha }, updated_at: "2026-01-01T09:10:00Z" },
      });
      Object.assign(conflicting.onGitHub, { headSha: sha, mergeable: true });
    };
    const check = (sha: string, conclusion: "success" | "failure" | null, name = "test") =>
      deliver(cronker, "check_run", {
        action: conclusion === null ? "created" : "completed",
        check_run: {
          id: 2000 + sha.length,
          name,
          head_sha: sha,
          status: conclusion === null ? "in_progress" : "completed",
          conclusion,
          html_url: null,
        },
      });
    const resolve = async (sha: string) => {
      await push(sha);
      const finished = await finish(conflicting.ticket.id, "resolved");
      expect(finished.status, JSON.stringify(finished.json)).toBe(200);
    };
    return { ...setting, tickets, conflicting, asAgent, running, finish, push, check, resolve };
  }

  test("steps aside with Cronk's Comment naming the merge and a Merge Run, and the next Ticket merges meanwhile", async () => {
    const { tickets, conflicting, read, status, cronkComments, running } = await conflictSetting();

    await cronk.checkQueue();
    await cronk.checkQueue();

    expect(cronk.github.merges.map((m) => m.number)).toEqual([101]);
    expect(await read(conflicting.ticket.id)).toMatchObject({
      statusId: status("Merge"),
      queue: {
        state: "resolving-conflict",
        position: null,
        pullRequestId: 602,
        conflict: {
          merge: { repository: "cronkcorp/cronker", number: 101, url: "https://github.com/cronkcorp/cronker/pull/101" },
          baseSha: "m101",
          count: 1,
        },
      },
    });
    expect((await cronkComments(conflicting.ticket.id)).at(-1)).toBe(
      "[cronkcorp/cronker#102](https://github.com/cronkcorp/cronker/pull/102) conflicts with `main` since " +
        "[cronkcorp/cronker#101](https://github.com/cronkcorp/cronker/pull/101) merged, so CRONK-2 stepped aside in the " +
        "Merge Queue, which moves on meanwhile; a Run of Merge resolves the conflict (1 of 3). Once the resolution's " +
        "checks are green, CRONK-2 rejoins the queue at the front.",
    );
    // A Merge Run, though the Project has agents may merge off and the Ticket has no Autonomous Delegation.
    expect((await running(conflicting.ticket.id))?.step.name).toBe("Merge");
    expect(cronk.runner.starts.at(-1)!.brief).toContain("**resolved**");
    expect(await read(tickets[2]!.ticket.id)).toMatchObject({ queue: { position: 1, state: "queued" } });

    await cronk.checkQueue();

    expect(cronk.github.merges.map((m) => m.number)).toEqual([101, 103]);
    expect(await read(conflicting.ticket.id)).toMatchObject({ queue: { state: "resolving-conflict" } });
  });

  test("resolved, then green checks, puts it back at the front of its queue, and it merges next", async () => {
    const { tickets, conflicting, read, status, resolve, check, runs } = await conflictSetting();
    await cronk.checkQueue();
    await cronk.checkQueue();

    await resolve("r1");

    expect(await read(conflicting.ticket.id)).toMatchObject({
      statusId: status("Merge"),
      queue: { state: "waiting-for-checks", position: null, conflict: { count: 1 } },
    });
    // No other Run starts on it, and it waits out of line while the resolution's checks are pending.
    expect((await runs(conflicting.ticket.id)).filter((s) => s === "Merge")).toHaveLength(1);
    await check("r1", null);
    await cronk.checkQueue();
    expect(cronk.github.merges.map((m) => m.number)).toEqual([101, 103]);
    expect(await read(conflicting.ticket.id)).toMatchObject({ queue: { state: "waiting-for-checks", position: null } });

    // The green check has it rejoin at the front, ahead of CRONK-4, and merge at once.
    await check("r1", "success");

    expect(cronk.github.merges.map((m) => m.number)).toEqual([101, 103, 102]);
    expect(await read(conflicting.ticket.id)).toMatchObject({ statusId: status("Done"), verification: "verified", queue: null });
    expect(await read(tickets[3]!.ticket.id)).toMatchObject({ queue: { position: 1, state: "queued" } });
  });

  test("a resolved Ticket rejoins ahead of the Tickets waiting, behind none", async () => {
    const { tickets, conflicting, read, resolve, check } = await conflictSetting();
    await cronk.checkQueue();
    await cronk.checkQueue();
    // GitHub is still working out whether CRONK-3 merges, so it waits as the head while CRONK-2 is resolved.
    tickets[2]!.onGitHub.mergeable = null;
    await resolve("r1");
    // Nor does GitHub know yet whether CRONK-2 merges, so it rejoins without merging.
    conflicting.onGitHub.mergeable = null;
    await check("r1", "success");

    expect(await read(conflicting.ticket.id)).toMatchObject({ queue: { position: 1, state: "queued" } });
    expect(await read(tickets[2]!.ticket.id)).toMatchObject({ queue: { position: 2, state: "queued" } });
    expect(await read(tickets[3]!.ticket.id)).toMatchObject({ queue: { position: 3, state: "queued" } });
  });

  test("failing checks on the resolution send it back to Implement as a round", async () => {
    const { conflicting, read, status, resolve, check, cronkComments } = await conflictSetting();
    await cronk.checkQueue();
    await cronk.checkQueue();
    await resolve("r1");

    await check("r1", "failure", "lint");

    expect(await read(conflicting.ticket.id)).toMatchObject({ statusId: status("Implement"), queue: null });
    expect((await cronkComments(conflicting.ticket.id)).at(-1)).toContain("The check **lint** failed on");
  });

  test("sending it back to Implement from the Merge Run works with a Comment and counts as no round", async () => {
    const { ada, project, status, conflicting, read, finish, cronkComments } = await conflictSetting();
    // With no rounds left, a send-back counting as one would hand it to its Assignee instead.
    const { step } = (await ok("GET", `/api/projects/${project.id}`, ada)).statuses.find((s: { name: string }) => s.name === "Merge");
    await ok("PUT", `/api/projects/${project.id}/statuses/${status("Merge")}/step`, ada, { ...step, roundLimit: 0 });
    await cronk.checkQueue();
    await cronk.checkQueue();
    const comments = (await cronkComments(conflicting.ticket.id)).length;

    const sent = await finish(conflicting.ticket.id, "send back");

    expect(sent.json).toMatchObject({ state: "finished", outcome: "send back", questionBy: null });
    expect(await read(conflicting.ticket.id)).toMatchObject({ statusId: status("Implement"), queue: null });
    expect(await cronkComments(conflicting.ticket.id)).toHaveLength(comments);
  });

  test("a fourth conflict hands it to its Assignee with Cronk's Question instead, none of them a round", async () => {
    const { workspace, ada, user, project, status, conflicting, read, resolve, check, runs } = await conflictSetting();
    await ok("PATCH", `/api/tickets/${conflicting.ticket.id}`, ada, { assigneeId: user.id });
    const { step } = (await ok("GET", `/api/projects/${project.id}`, ada)).statuses.find((s: { name: string }) => s.name === "Merge");
    await ok("PUT", `/api/projects/${project.id}/statuses/${status("Merge")}/step`, ada, { ...step, roundLimit: 0 });
    await cronk.checkQueue();
    await cronk.checkQueue();
    for (const round of [1, 2, 3]) {
      expect(await read(conflicting.ticket.id)).toMatchObject({ queue: { state: "resolving-conflict", conflict: { count: round } } });
      await resolve(`r${round}`);
      // It rejoins, but conflicts again before it merges.
      conflicting.onGitHub.mergeable = false;
      conflicting.onGitHub.baseSha = `b${round}`;
      await check(`r${round}`, "success");
      await cronk.checkQueue();
    }

    expect(await read(conflicting.ticket.id)).toMatchObject({ statusId: status("In Review"), queue: null });
    expect((await runs(conflicting.ticket.id)).filter((s) => s === "Merge")).toHaveLength(3);
    const { items } = await ok("GET", `/api/workspaces/${workspace.id}/inbox`, ada);
    expect(items.filter((i: { kind: string }) => i.kind === "needsYou")).toEqual([
      expect.objectContaining({
        ticket: expect.objectContaining({ key: "CRONK-2" }),
        outcome: "needs you",
        question:
          "cronkcorp/cronker#102 conflicts with main, and CRONK-2 already stepped aside for conflicts 3 times, so it left " +
          "the Merge Queue. Resolve the conflict yourself, or send it back to work, then press Merge again.",
      }),
    ]);
  });

  test("a Ticket with no Delegate to resolve it comes to its Assignee instead, the queue moving on", async () => {
    const { workspace, ada, user, inReview, merge, read, status } = await queueSetting();
    const first = await inReview();
    const second = await inReview();
    await ok("PATCH", `/api/tickets/${second.ticket.id}`, ada, { assigneeId: user.id });
    first.onGitHub.conflicts = [second.onGitHub];
    const third = await inReview();
    for (const { ticket } of [first, second, third]) await merge(ticket.id);

    await cronk.checkQueue();
    await cronk.checkQueue();

    expect(await read(second.ticket.id)).toMatchObject({ statusId: status("In Review"), queue: null });
    const { items } = await ok("GET", `/api/workspaces/${workspace.id}/inbox`, ada);
    expect(items.find((i: { kind: string }) => i.kind === "needsYou")).toMatchObject({
      question: expect.stringContaining("CRONK-2 isn't delegated, so no Run can resolve it"),
    });
    await cronk.checkQueue();
    expect(cronk.github.merges.map((m) => m.number)).toEqual([101, 103]);
  });

  test("resolved is refused to a Merge Run with no conflict to resolve", async () => {
    const setting = await queueSetting();
    const { workspace, ada, project, status, deliver, cronker } = setting;
    await ok("PATCH", `/api/projects/${project.id}`, ada, { agentsMayMerge: true });
    const runner = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
    const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
    const agent = await ok("PATCH", `/api/agents/${created.id}`, ada, { runnerId: runner.id });
    const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "cloud", access: "write" });
    const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Make it so" });
    await deliver(cronker, "pull_request", {
      action: "opened",
      pull_request: {
        id: 601, number: 101, title: `${ticket.key}: make it so`, state: "open", draft: true, merged: false,
        html_url: "https://github.com/cronkcorp/cronker/pull/101", head: { ref: "cronk-1", sha: "c101" }, base: { ref: "main" },
        created_at: "2026-01-01T09:00:00Z", updated_at: "2026-01-01T09:00:00Z",
      },
    });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, autonomousDelegation: true, statusId: status("Merge") });
    const [run] = await ok("GET", `/api/tickets/${ticket.id}/runs`, ada);

    const refused = await call("POST", `/api/runs/${run.id}/finish`, { headers: { authorization: `Bearer ${secret}` } }, { outcome: "resolved" });

    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ error: { code: "nothing_to_resolve" } });
  });
});

describe("while GitHub is unavailable", () => {
  test("the queue asks GitHub nothing until the wait ends, its heads waiting as they were, then merges them", async () => {
    const { inReview, merge, read, status, website } = await queueSetting();
    const onCronker = await inReview();
    const onWebsite = await inReview({ repository: website });
    await merge(onCronker.ticket.id);
    await merge(onWebsite.ticket.id);
    cronk.github.unavailable = true;

    await cronk.checkQueue();
    // The first head met the outage; the other queue's head waits rather than asking GitHub too.
    const calls = cronk.github.apiCalls.length;
    for (let i = 0; i < 2; i++) {
      cronk.clock.advance(seconds(10));
      await cronk.checkQueue();
    }

    expect(cronk.github.apiCalls).toHaveLength(calls);
    for (const { ticket } of [onCronker, onWebsite]) {
      expect(await read(ticket.id)).toMatchObject({ statusId: status("Merge"), queue: { position: 1, state: "queued" } });
    }

    cronk.github.unavailable = false;
    cronk.clock.advance(seconds(10));
    await cronk.checkQueue();

    expect(cronk.github.merges.map((m) => `${m.repository}#${m.number}`).sort()).toEqual(["cronkcorp/cronker#101", "cronkcorp/website#102"]);
    expect(await read(onCronker.ticket.id)).toMatchObject({ statusId: status("Done"), verification: "verified" });
  });
});
