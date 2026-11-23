import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { hours } from "../harness/clock.js";
import { createGitHubApp, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

// Backports (the Releases spec): a Ticket of a cut Release merging into the default branch after the Cut waits in Merge
// while a Run of the Merge Step backports it onto the release branch, and completes once both have merged.

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
 * Ada's Project listing cronkcorp/cronker, with the Release v0.3.0 and CRONK-1 tagged with it, delegated to her Agent
 * claude-max on her fake Runner, its Pull Request #101 open on `main`, green and mergeable. The Release is then cut, and
 * the clock moves on an hour, so merges come after the Cut unless a test says otherwise.
 */
async function setting({ autonomous = false, cut = true, opened = true, tagged = true } = {}) {
  const { workspace, user } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id as string;
  await createGitHubApp(cronk, ada.cookie!);
  const app = cronk.github.apps[0]!;
  const installation = cronk.github.install(app, "cronkcorp", ["cronker"]);
  const cronker = installation.repositories[0]!;
  await ok("POST", `/api/projects/${project.id}/repositories`, ada, { id: cronker.id });
  if (autonomous) await ok("PATCH", `/api/projects/${project.id}`, ada, { agentsMayMerge: true });
  const runner = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, ada, { runnerId: runner.id });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "cloud", access: "write" });
  const asAgent = { headers: { authorization: `Bearer ${secret}` } };
  const release = await ok("POST", `/api/projects/${project.id}/releases`, ada, { name: "v0.3.0" });
  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, {
    title: "Make it so",
    ...(tagged ? { release: "v0.3.0" } : {}),
  });

  const deliver = async (event: string, payload: Record<string, unknown>) => {
    const delivered = await cronk.github.deliver(app, event, {
      installation: { id: installation.id },
      repository: { id: cronker.id, full_name: cronker.fullName },
      ...payload,
    });
    expect(delivered.status).toBe(200);
  };
  const pullRequestOf = (number: number, base: string, title = `CRONK-1: make it so`) => ({
    id: 500 + number,
    number,
    title,
    state: "open",
    draft: false,
    merged: false,
    html_url: `https://github.com/${cronker.fullName}/pull/${number}`,
    head: { ref: `branch-${number}`, sha: `c${number}` },
    base: { ref: base },
    created_at: "2026-01-01T09:00:00Z",
    updated_at: "2026-01-01T09:00:00Z",
  });
  /** Opens Pull Request #number on `base`, its one check green, GitHub saying it is mergeable. */
  const open = async (number: number, base: string, title?: string) => {
    const pullRequest = pullRequestOf(number, base, title);
    await deliver("pull_request", { action: "opened", pull_request: pullRequest });
    await deliver("check_run", {
      action: "completed",
      check_run: { id: number, name: "test", head_sha: pullRequest.head.sha, status: "completed", conclusion: "success", html_url: null },
    });
    cronk.github.pullRequest(cronker, number, { headSha: pullRequest.head.sha, mergeable: true, base });
    return pullRequest;
  };
  /** GitHub's delivery of Pull Request #number merged on GitHub, by bea, at `mergedAt`. */
  const mergeOnGitHub = async (number: number, base: string, mergedAt: string) => {
    await deliver("pull_request", {
      action: "closed",
      pull_request: {
        ...pullRequestOf(number, base),
        state: "closed",
        merged: true,
        merged_by: { type: "User", login: "bea", id: 4001 },
        merge_commit_sha: `m${number}`,
        merged_at: mergedAt,
        auto_merge: null,
        updated_at: "2026-01-02T09:00:00Z",
      },
    });
  };

  if (opened) await open(101, "main");
  if (autonomous) {
    // Code review approves it, and it joins the queue for claude-max as it enters Merge.
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, autonomousDelegation: true, statusId: status("Code review") });
  } else {
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, autonomousDelegation: false, statusId: status("In Review") });
  }
  if (cut) {
    const answer = await call("POST", `/api/projects/${project.id}/releases/${release.id}/cut`, ada);
    expect(answer.status, JSON.stringify(answer.json)).toBe(200);
  }
  cronk.clock.advance(hours(1));

  const read = () => ok("GET", `/api/tickets/${ticket.id}`, ada);
  const runs = () => ok("GET", `/api/tickets/${ticket.id}/runs`, ada) as Promise<{ id: string; state: string; step: { name: string } }[]>;
  const running = async () => (await runs()).find((r) => r.state === "running");
  const finish = async (outcome: string) => call("POST", `/api/runs/${(await running())!.id}/finish`, asAgent, { outcome });
  const approve = async () => expect((await finish("approve")).status).toBe(200);
  const cronkComments = async () =>
    ((await ok("GET", `/api/tickets/${ticket.id}/comments`, ada)) as { actor: { kind: string }; body: string }[])
      .filter((c) => c.actor.kind === "cronk")
      .map((c) => c.body);
  return {
    workspace, user, ada, project, status, cronker, agent, asAgent, release, ticket, open, mergeOnGitHub, read, runs, running,
    finish, approve, cronkComments,
  };
}

describe("A Ticket of a cut Release", () => {
  test("merging before the Cut completes as today", async () => {
    const { mergeOnGitHub, read, status, runs } = await setting();

    await mergeOnGitHub(101, "main", "2026-01-01T08:00:00Z");

    // bea isn't a User of the Workspace, so it completes Unverified, as any merge on GitHub by a stranger does.
    expect(await read()).toMatchObject({ statusId: status("Done"), verification: "unverified", backport: null });
    expect((await runs()).map((r) => r.step.name)).toEqual([]);
  });

  test("merging through a User's queue after the Cut waits in Merge, and a Run backports it with a Brief naming the branch and merge commit", async () => {
    const { ada, ticket, read, status, running, cronkComments } = await setting();
    await ok("POST", `/api/tickets/${ticket.id}/merge`, ada);

    await cronk.checkQueue();

    expect(cronk.github.merges.map((m) => m.number)).toEqual([101]);
    expect(await read()).toMatchObject({
      statusId: status("Merge"),
      queue: null,
      backport: { state: "backporting", branch: "release/v0.3.0", mergeCommit: "m101" },
    });
    expect((await running())?.step.name).toBe("Merge");
    const brief = cronk.runner.starts.at(-1)!.brief;
    expect(brief).toContain("This Run backports CRONK-1 onto its Release v0.3.0");
    expect(brief).toContain("as `m101`");
    expect(brief).toContain("`backport/CRONK-1-v0.3.0` off `release/v0.3.0`");
    expect(brief).toContain("**backported**");
    expect((await cronkComments()).at(-1)).toContain("merged after v0.3.0 was cut, so CRONK-1 waits in Merge");
  });

  test("backported, its backport joins the release branch's queue as the User's, and its merge completes it Verified", async () => {
    const { ada, user, ticket, read, status, open, finish } = await setting();
    await ok("POST", `/api/tickets/${ticket.id}/merge`, ada);
    await cronk.checkQueue();

    // The Run opens the backport before finishing: it links, but waits for *backported* to queue.
    await open(102, "release/v0.3.0", "CRONK-1: backport make it so");
    expect(await read()).toMatchObject({ queue: null, backport: { state: "backporting" } });
    const finished = await finish("backported");
    expect(finished.status, JSON.stringify(finished.json)).toBe(200);

    expect(await read()).toMatchObject({ statusId: status("Merge"), queue: { state: "queued", pullRequestId: 602 }, backport: { state: "backported" } });
    const timeline = await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada);
    expect(timeline.filter((c: { field: string }) => c.field === "queueJoined").at(-1)).toMatchObject({
      actor: { kind: "cronk" },
      to: { pullRequest: { id: 602, number: 102 } },
    });

    await cronk.checkQueue();

    expect(cronk.github.merges.map((m) => m.number)).toEqual([101, 102]);
    expect(await read()).toMatchObject({ statusId: status("Done"), verification: "verified", backport: null, queue: null });
    const merged = (await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada)).filter((c: { field: string }) => c.field === "merged");
    expect(merged.map((c: { actor: { id?: string } }) => c.actor.id)).toEqual([user.id, user.id]);
  });

  test("under Autonomous Delegation, the backport linked after backported joins the queue as the Agent's, completing it Unverified", async () => {
    const { ada, ticket, read, status, open, finish, approve, agent, runs } = await setting({ autonomous: true });
    await approve();
    expect(await read()).toMatchObject({ statusId: status("Merge"), queue: { state: "queued" } });

    await cronk.checkQueue();
    expect(await read()).toMatchObject({ statusId: status("Merge"), backport: { state: "backporting" } });
    expect((await finish("backported")).status).toBe(200);
    // Nothing to queue yet, and no other Run.
    expect(await read()).toMatchObject({ statusId: status("Merge"), queue: null, backport: { state: "backported" } });
    expect((await runs()).filter((r) => r.state === "running")).toEqual([]);

    await open(102, "release/v0.3.0", "CRONK-1: backport");
    expect(await read()).toMatchObject({ queue: { state: "queued", pullRequestId: 602 } });
    await cronk.checkQueue();

    expect(await read()).toMatchObject({ statusId: status("Done"), verification: "unverified" });
    expect(cronk.github.merges.map((m) => m.number)).toEqual([101, 102]);
    const merged = (await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada)).filter((c: { field: string }) => c.field === "merged");
    expect(merged.map((c: { actor: { kind: string; id?: string } }) => [c.actor.kind, c.actor.id])).toEqual([
      ["agent", agent.id],
      ["agent", agent.id],
    ]);
  });

  test("send back returns it to Implement, with the Run's Comment, counting as no round", async () => {
    const { ada, project, ticket, read, status, finish, asAgent, running } = await setting();
    const { step } = (await ok("GET", `/api/projects/${project.id}`, ada)).statuses.find((s: { name: string }) => s.name === "Merge");
    await ok("PUT", `/api/projects/${project.id}/statuses/${status("Merge")}/step`, ada, { ...step, roundLimit: 0 });
    await ok("POST", `/api/tickets/${ticket.id}/merge`, ada);
    await cronk.checkQueue();
    expect((await running())?.step.name).toBe("Merge");

    await ok("POST", `/api/tickets/${ticket.id}/comments`, asAgent, { body: "The cherry-pick conflicts in the board's ordering." });
    const sent = await finish("send back");

    expect(sent.json).toMatchObject({ state: "finished", outcome: "send back", questionBy: null });
    expect(await read()).toMatchObject({ statusId: status("Implement"), backport: null });
    const comments = await ok("GET", `/api/tickets/${ticket.id}/comments`, ada);
    expect(comments.at(-1)).toMatchObject({ actor: { kind: "agent" }, body: "The cherry-pick conflicts in the board's ordering." });
  });

  test("backported is refused to a Merge Run with nothing to backport", async () => {
    const { read, status, finish, approve, running } = await setting({ autonomous: true, opened: false });
    // With no Pull Request to queue, it gets a Merge Run to find out why.
    await approve();
    expect(await read()).toMatchObject({ statusId: status("Merge"), backport: null });
    expect((await running())?.step.name).toBe("Merge");

    const refused = await finish("backported");

    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ error: { code: "nothing_to_backport" } });
  });

  test("merging both Pull Requests on GitHub outside the queue completes it only after the second", async () => {
    const { read, status, runs, open, mergeOnGitHub, cronkComments } = await setting();
    await open(102, "release/v0.3.0", "CRONK-1: backport");

    await mergeOnGitHub(102, "release/v0.3.0", "2026-01-01T10:10:00Z");
    expect(await read()).toMatchObject({ statusId: status("In Review"), backport: null });

    await mergeOnGitHub(101, "main", "2026-01-01T10:20:00Z");
    expect(await read()).toMatchObject({ statusId: status("Done"), verification: "unverified" });
    expect((await runs()).map((r) => r.step.name)).toEqual([]);
    expect(await cronkComments()).toEqual([]);
  });

  test("merged on GitHub after the Cut, the backport goes to In Review for a User to press Merge", async () => {
    const { ada, ticket, read, status, running, open, mergeOnGitHub, finish, cronkComments } = await setting();

    await mergeOnGitHub(101, "main", "2026-01-01T10:10:00Z");
    expect(await read()).toMatchObject({ statusId: status("Merge"), backport: { state: "backporting", mergeCommit: "m101" } });
    expect((await running())?.step.name).toBe("Merge");

    await open(102, "release/v0.3.0", "CRONK-1: backport");
    expect((await finish("backported")).status).toBe(200);

    expect(await read()).toMatchObject({ statusId: status("In Review"), queue: null, backport: null });
    expect((await cronkComments()).at(-1)).toContain("press **Merge** to queue the backport");

    await ok("POST", `/api/tickets/${ticket.id}/merge`, ada);
    await cronk.checkQueue();
    expect(await read()).toMatchObject({ statusId: status("Done"), verification: "verified" });
  });

  test("with Pull Request automation off, nothing waits and no Run starts", async () => {
    const { ada, project, read, status, runs, mergeOnGitHub } = await setting();
    await ok("PATCH", `/api/projects/${project.id}`, ada, { pullRequestAutomation: false });

    await mergeOnGitHub(101, "main", "2026-01-01T10:10:00Z");

    expect(await read()).toMatchObject({ statusId: status("In Review"), backport: null });
    expect(await runs()).toEqual([]);
  });
});

describe("Tagging a completed Ticket with a cut Release", () => {
  /** The commit `release/v0.3.0` was cut at in cronker. */
  const cutCommit = (cronker: { branches?: Map<string, string> }) => cronker.branches!.get("release/v0.3.0")!;
  const compares = () => cronk.github.apiCalls.filter((c) => c.includes("/compare/"));

  test("whose merge came after the Cut moves it into Merge as the User's, and a Run backports it", async () => {
    const { ada, user, ticket, cronker, read, status, running, open, mergeOnGitHub, finish, cronkComments } = await setting({ tagged: false });
    await mergeOnGitHub(101, "main", "2026-01-01T10:10:00Z");
    expect(await read()).toMatchObject({ statusId: status("Done"), verification: "unverified", release: null });

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { release: "v0.3.0" });

    expect(compares()).toEqual([`GET /repos/${cronker.fullName}/compare/m101...${cutCommit(cronker)}`]);
    expect(await read()).toMatchObject({
      statusId: status("Merge"),
      verification: null,
      release: { name: "v0.3.0", state: "cut" },
      backport: { state: "backporting", branch: "release/v0.3.0", mergeCommit: "m101" },
    });
    expect((await running())?.step.name).toBe("Merge");
    expect(cronk.runner.starts.at(-1)!.brief).toContain("This Run backports CRONK-1 onto its Release v0.3.0");
    expect((await cronkComments()).at(-1)).toContain("isn't in `release/v0.3.0`, so it waits in Merge");
    // The timeline shows the tag and the move, both by the User who tagged it.
    const timeline = await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada);
    const tagged = timeline.filter((c: { field: string }) => c.field === "release" || c.field === "status").slice(-2);
    expect(tagged).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "release", actor: expect.objectContaining({ id: user.id }), to: expect.objectContaining({ name: "v0.3.0" }) }),
        expect.objectContaining({ field: "status", actor: expect.objectContaining({ id: user.id }), to: expect.objectContaining({ name: "Merge" }) }),
      ]),
    );

    // Its backport joins the queue as the tagging User's, and merging it completes the Ticket Verified.
    await open(102, "release/v0.3.0", "CRONK-1: backport make it so");
    expect((await finish("backported")).status).toBe(200);
    expect(await read()).toMatchObject({ statusId: status("Merge"), queue: { state: "queued", pullRequestId: 602 } });
    await cronk.checkQueue();
    expect(await read()).toMatchObject({ statusId: status("Done"), verification: "verified", backport: null });
  });

  test("whose merge came before the Cut only tags it", async () => {
    const { ada, ticket, cronker, read, status, runs, mergeOnGitHub } = await setting({ tagged: false });
    await mergeOnGitHub(101, "main", "2026-01-01T08:00:00Z");
    cronker.ancestors = new Map([[cutCommit(cronker), new Set(["m101"])]]);

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { release: "v0.3.0" });

    expect(compares()).toHaveLength(1);
    expect(await read()).toMatchObject({ statusId: status("Done"), verification: "unverified", release: { name: "v0.3.0" }, backport: null });
    expect(await runs()).toEqual([]);
  });

  test("with no merged Pull Request only tags it", async () => {
    const { ada, ticket, read, status, runs } = await setting({ tagged: false, opened: false });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Done") });
    const before = (await runs()).length;

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { release: "v0.3.0" });

    expect(compares()).toEqual([]);
    expect(await read()).toMatchObject({ statusId: status("Done"), release: { name: "v0.3.0" }, backport: null });
    expect(await runs()).toHaveLength(before);
  });

  test("with Pull Request automation off only tags it", async () => {
    const { ada, project, ticket, read, status, runs, mergeOnGitHub } = await setting({ tagged: false });
    await mergeOnGitHub(101, "main", "2026-01-01T10:10:00Z");
    await ok("PATCH", `/api/projects/${project.id}`, ada, { pullRequestAutomation: false });

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { release: "v0.3.0" });

    expect(compares()).toEqual([]);
    expect(await read()).toMatchObject({ statusId: status("Done"), release: { name: "v0.3.0" }, backport: null });
    expect(await runs()).toEqual([]);
  });

  test("is refused for a Ticket that isn't completed, and for a released Release", async () => {
    const { ada, project, release, ticket, mergeOnGitHub } = await setting({ tagged: false });
    const open = await call("PATCH", `/api/tickets/${ticket.id}`, ada, { release: "v0.3.0" });
    expect([open.status, open.json.error.code]).toEqual([409, "release_not_planned"]);

    await mergeOnGitHub(101, "main", "2026-01-01T10:10:00Z");
    await ok("POST", `/api/projects/${project.id}/releases/${release.id}/release`, ada, { confirm: true });
    const released = await call("PATCH", `/api/tickets/${ticket.id}`, ada, { release: "v0.3.0" });
    expect([released.status, released.json.error.code]).toEqual([409, "release_not_planned"]);
  });
});
