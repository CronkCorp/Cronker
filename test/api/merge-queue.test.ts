import { afterEach, beforeEach, describe, expect, test } from "vitest";
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

  /** A Ticket in In Review whose Pull Request is open, its one check green and GitHub saying it is mergeable. */
  const inReview = async ({ repository = cronker, base = "main", check = "success" as string | null } = {}) => {
    const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Make it so" });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("In Review") });
    const number = Number(ticket.key.split("-")[1]) + 100;
    const pullRequest = pullRequestOf(number, ticket.key, repository, base);
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
    return { ticket, pullRequest, onGitHub, repository, number };
  };
  const merge = (ticketId: string, as: As = ada) => call("POST", `/api/tickets/${ticketId}/merge`, as);
  const read = (ticketId: string) => ok("GET", `/api/tickets/${ticketId}`, ada);
  return { workspace, user, ada, project, status, app, installation, cronker, website, deliver, inReview, merge, read };
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
    await cronk.checkQueue();

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
