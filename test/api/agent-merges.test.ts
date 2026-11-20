import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createGitHubApp, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

// An Agent's Merge Run merges its Ticket's Pull Request through Cronk's merge_pull_request (ADR 0005, ADR 0007).

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
 * Ada's Project on the default board, listing cronkcorp/cronker, with agents may merge on, and her Ticket CRONK-1
 * delegated with Autonomous Delegation to claude-max on her fake Runner. Its Implement Run opened Pull Request #7,
 * whose one check passed and which GitHub says is mergeable, and Code review approved it: a Merge Run is running.
 */
async function mergeRunning({ agentsMayMerge = true, autonomous = true } = {}) {
  const { workspace, user } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id as string;
  await ok("PATCH", `/api/projects/${project.id}`, ada, { agentsMayMerge: true });
  const runner = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, ada, { runnerId: runner.id });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "cloud", access: "full" });
  const asAgent = { headers: { authorization: `Bearer ${secret}` } };

  await createGitHubApp(cronk, ada.cookie);
  const app = cronk.github.apps[0]!;
  const installation = cronk.github.install(app, "cronkcorp", ["cronker"]);
  const cronker = installation.repositories[0]!;
  await ok("POST", `/api/projects/${project.id}/repositories`, ada, { id: cronker.id });

  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Make it so" });
  await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, autonomousDelegation: true, statusId: status("Implement") });
  const repository = { id: cronker.id, full_name: cronker.fullName };
  const pullRequest = {
    id: 501,
    number: 7,
    title: "CRONK-1: make it so",
    state: "open",
    draft: false,
    merged: false,
    html_url: "https://github.com/cronkcorp/cronker/pull/7",
    head: { ref: "cronk-1-make-it-so", sha: "c1" },
    created_at: "2026-01-01T09:00:00Z",
    updated_at: "2026-01-01T09:00:00Z",
  };
  const deliver = async (event: string, payload: Record<string, unknown>) => {
    const delivered = await cronk.github.deliver(app, event, { installation: { id: installation.id }, repository, ...payload });
    expect(delivered.status).toBe(200);
  };
  await deliver("pull_request", { action: "opened", pull_request: pullRequest });
  const checkRun = (id: number, name: string, status: string, conclusion: string | null = null) =>
    deliver("check_run", {
      action: status === "completed" ? "completed" : "created",
      check_run: { id, name, head_sha: "c1", status, conclusion, html_url: `https://github.com/cronkcorp/cronker/runs/${id}` },
    });
  await checkRun(1, "test", "completed", "success");
  const onGitHub = cronk.github.pullRequest(cronker, 7, { headSha: "c1", mergeable: true });

  const runningRun = async () => {
    const runs = await ok("GET", `/api/tickets/${ticket.id}/runs`, ada);
    return runs.find((r: { state: string }) => r.state === "running") as { id: string; step: { name: string } };
  };
  const finish = async (outcome: string, question?: string) =>
    ok("POST", `/api/runs/${(await runningRun()).id}/finish`, asAgent, { outcome, question });
  await finish("done");
  await finish("approve");
  // Set last, so the Ticket still reaches Merge with a Run there.
  if (!agentsMayMerge) await ok("PATCH", `/api/projects/${project.id}`, ada, { agentsMayMerge: false });
  if (!autonomous) await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { autonomousDelegation: false });
  const run = await runningRun();
  expect(run.step.name).toBe("Merge");
  const merge = (as: As = asAgent, pullRequestId = 501) => call("POST", `/api/runs/${run.id}/merge`, as, { pullRequestId });

  return {
    workspace, user, ada, project, status, agent, asAgent, app, installation, cronker, ticket, run, onGitHub,
    deliver, checkRun, finish, runningRun, merge, pullRequest,
  };
}

describe("a Merge Run merges its Ticket's Pull Request", () => {
  test("with the App's token and the Repository's default merge method; the Run finishes with merged", async () => {
    const { merge, run, installation } = await mergeRunning();

    const merged = await merge();

    expect(merged.status).toBe(200);
    expect(merged.json).toMatchObject({ id: run.id, state: "finished", outcome: "merged" });
    expect(cronk.github.merges).toEqual([
      { repository: "cronkcorp/cronker", number: 7, method: "merge", sha: "c1", installationId: installation.id },
    ]);
  });

  test("by the first merge method the Repository's settings allow, of a merge commit, squashing and rebasing", async () => {
    const { merge, cronker } = await mergeRunning();
    cronker.mergeMethods = { merge: false, squash: false, rebase: true };

    expect((await merge()).status).toBe(200);

    expect(cronk.github.merges.map((m) => m.method)).toEqual(["rebase"]);
  });

  test("completes the Ticket as Unverified into its Assignee's Inbox, Reopen sending it back to Implement", async () => {
    const { merge, ada, ticket, status, workspace } = await mergeRunning();

    await merge();

    expect(await ok("GET", `/api/tickets/${ticket.id}`, ada)).toMatchObject({ statusId: status("Done"), verification: "unverified" });
    const { items } = await ok("GET", `/api/workspaces/${workspace.id}/inbox`, ada);
    expect(items.filter((i: { kind: string }) => i.kind === "unverified")).toEqual([
      expect.objectContaining({
        ticket: expect.objectContaining({ key: "CRONK-1" }),
        completedBy: { id: status("Implement"), name: "Implement" },
        completedWithoutStep: false,
      }),
    ]);
    expect(await ok("GET", `/api/tickets/${ticket.id}/completion`, ada)).toMatchObject({
      merge: { pullRequest: { id: 501, repository: "cronkcorp/cronker", number: 7 }, mergedBy: null },
      reopen: { kind: "back", status: { id: status("Implement"), name: "Implement" } },
    });
    // No Run starts in Done.
    expect((await ok("GET", `/api/tickets/${ticket.id}/runs`, ada)).filter((r: { state: string }) => r.state === "running")).toEqual([]);
  });

  test("the timeline shows the merge as the Agent's in its Merge Run, then the move to Done as Unverified", async () => {
    const { merge, ada, ticket, status, run, agent } = await mergeRunning();

    await merge();

    const timeline = await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada);
    const last = timeline.slice(-3).map(({ actor, field, from, to, runId }: Record<string, unknown>) => ({ actor, field, from, to, runId }));
    const byAgent = { kind: "agent", id: agent.id, name: "claude-max" };
    expect(last).toEqual([
      {
        actor: expect.objectContaining(byAgent),
        field: "merged",
        from: null,
        to: {
          pullRequest: { id: 501, repository: "cronkcorp/cronker", number: 7, title: "CRONK-1: make it so", url: "https://github.com/cronkcorp/cronker/pull/7" },
          mergedBy: null,
        },
        runId: run.id,
      },
      {
        actor: expect.objectContaining(byAgent),
        field: "status",
        from: { id: status("Merge"), name: "Merge" },
        to: { id: status("Done"), name: "Done" },
        runId: run.id,
      },
      { actor: expect.objectContaining(byAgent), field: "verification", from: null, to: "unverified", runId: run.id },
    ]);
  });

  test("the Pull Request shows merged at once, and GitHub's own delivery of the merge completes nothing again", async () => {
    const { merge, ada, ticket, deliver, pullRequest, status } = await mergeRunning();
    await merge();
    expect((await ok("GET", `/api/tickets/${ticket.id}/pull-requests`, ada))[0]).toMatchObject({ id: 501, state: "merged" });
    const changes = (await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada)).length;

    await deliver("pull_request", {
      action: "closed",
      pull_request: {
        ...pullRequest,
        state: "closed",
        merged: true,
        merged_by: { login: "cronk-app[bot]", id: 4242, type: "Bot" },
        updated_at: "2026-01-01T09:05:00Z",
      },
    });

    expect((await ok("GET", `/api/tickets/${ticket.id}/pull-requests`, ada))[0]).toMatchObject({ state: "merged", mergedBy: "cronk-app[bot]" });
    expect((await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada)).length).toBe(changes);
    expect(await ok("GET", `/api/tickets/${ticket.id}`, ada)).toMatchObject({ statusId: status("Done"), verification: "unverified" });
  });
});

describe("Cronk refuses a merge, naming the rule, and the Run goes on", () => {
  /** Expects the merge refused with the code and rule, nothing merged on GitHub and the Run still running. */
  async function refused(
    setup: Awaited<ReturnType<typeof mergeRunning>>,
    attempt: Promise<{ status: number; json: { error: { code: string; message: string; rule: string; advice: string } } }>,
    expected: { status: number; code: string; rule: string },
  ) {
    const { status, json } = await attempt;
    expect({ status, code: json.error.code, rule: json.error.rule }).toEqual(expected);
    expect(json.error.advice).toEqual(expect.any(String));
    expect(cronk.github.merges).toEqual([]);
    expect(await ok("GET", `/api/runs/${setup.run.id}`, setup.ada)).toMatchObject({ state: "running" });
    expect(await ok("GET", `/api/tickets/${setup.ticket.id}`, setup.ada)).toMatchObject({ statusId: setup.status("Merge") });
    return json.error;
  }

  test("a Pull Request not linked to the Run's Ticket", async () => {
    const setup = await mergeRunning();
    const other = await ok("POST", `/api/projects/${setup.project.id}/tickets`, setup.ada, { title: "Something else" });
    await setup.deliver("pull_request", {
      action: "opened",
      pull_request: { ...setup.pullRequest, id: 502, number: 8, title: "CRONK-2: something else", head: { ref: "cronk-2", sha: "d1" } },
    });
    expect(other.key).toBe("CRONK-2");

    const error = await refused(setup, setup.merge(setup.asAgent, 502), {
      status: 403,
      code: "pull_request_not_linked",
      rule: "A Merge Run merges only a Pull Request linked to its own Ticket.",
    });
    expect(error.message).toBe("That Pull Request isn't linked to CRONK-1.");
    await refused(setup, setup.merge(setup.asAgent, 999), {
      status: 403,
      code: "pull_request_not_linked",
      rule: "A Merge Run merges only a Pull Request linked to its own Ticket.",
    });
  });

  test("a Ticket without Autonomous Delegation", async () => {
    const setup = await mergeRunning({ autonomous: false });

    const error = await refused(setup, setup.merge(), {
      status: 403,
      code: "no_autonomous_delegation",
      rule: "Agents merge only Tickets under Autonomous Delegation.",
    });
    expect(error.advice).toBe("Finish with review, leaving the merge to a User.");
  });

  test("a Project with agents may merge off", async () => {
    const setup = await mergeRunning({ agentsMayMerge: false });

    await refused(setup, setup.merge(), {
      status: 403,
      code: "agents_may_not_merge",
      rule: "Agents merge only in Projects with agents may merge on, which only an Admin turns on.",
    });
  });

  test("a Pull Request GitHub says can't be merged, as with a merge conflict, or hasn't worked out yet", async () => {
    const setup = await mergeRunning();
    setup.onGitHub.mergeable = false;

    const conflict = await refused(setup, setup.merge(), {
      status: 409,
      code: "not_mergeable",
      rule: "Cronk merges only a Pull Request GitHub says is mergeable.",
    });
    expect(conflict.message).toBe("GitHub says cronkcorp/cronker#7 can't be merged, as when it has a merge conflict.");
    expect(conflict.advice).toBe(
      "Finish with send back, saying in a Comment that cronkcorp/cronker#7 has a merge conflict: it goes back to be fixed, as a round.",
    );

    setup.onGitHub.mergeable = null;
    const unknown = await refused(setup, setup.merge(), {
      status: 409,
      code: "not_mergeable",
      rule: "Cronk merges only a Pull Request GitHub says is mergeable.",
    });
    expect(unknown.message).toBe("GitHub is still working out whether cronkcorp/cronker#7 can be merged.");
  });

  test("a failing check on its latest commit", async () => {
    const setup = await mergeRunning();
    await setup.checkRun(2, "lint", "completed", "failure");

    const error = await refused(setup, setup.merge(), {
      status: 409,
      code: "checks_failing",
      rule: "Cronk merges only a Pull Request whose checks on its latest commit are green, with none pending.",
    });
    expect(error.message).toBe("The check lint failed on cronkcorp/cronker#7's latest commit, so it can't be merged.");
  });

  test("a check still running on its latest commit, or a commit Cronk hasn't heard of", async () => {
    const setup = await mergeRunning();
    await setup.checkRun(3, "e2e", "in_progress");

    const error = await refused(setup, setup.merge(), {
      status: 409,
      code: "checks_pending",
      rule: "Cronk merges only a Pull Request whose checks on its latest commit are green, with none pending.",
    });
    expect(error.message).toBe("The check e2e is still running on cronkcorp/cronker#7's latest commit, so it can't be merged yet.");

    await setup.checkRun(3, "e2e", "completed", "success");
    setup.onGitHub.headSha = "c2";
    const pushed = await refused(setup, setup.merge(), {
      status: 409,
      code: "checks_pending",
      rule: "Cronk merges only a Pull Request whose checks on its latest commit are green, with none pending.",
    });
    expect(pushed.message).toBe("cronkcorp/cronker#7 has a commit Cronk hasn't heard of yet, so its checks aren't known.");
  });

  test("a review still requesting changes", async () => {
    const setup = await mergeRunning();
    await setup.deliver("pull_request_review", {
      action: "submitted",
      review: { id: 71, state: "changes_requested", html_url: null, user: { login: "bea" } },
      pull_request: { id: 501 },
    });

    const error = await refused(setup, setup.merge(), {
      status: 409,
      code: "changes_requested",
      rule: "Cronk merges only a Pull Request no review still requests changes on.",
    });
    expect(error.message).toBe("@bea still requests changes on cronkcorp/cronker#7, so it can't be merged.");
  });

  test("a Project with Pull Request automation off, where merges complete nothing", async () => {
    const setup = await mergeRunning();
    await ok("PATCH", `/api/projects/${setup.project.id}`, setup.ada, { pullRequestAutomation: false });

    await refused(setup, setup.merge(), {
      status: 409,
      code: "pull_request_automation_off",
      rule: "Agents merge only in Projects whose merges complete their Tickets, with Pull Request automation on.",
    });
  });

  test("GitHub's own refusal, such as a merge its settings or branch protection forbid, goes to the Assignee", async () => {
    const setup = await mergeRunning();
    setup.cronker.mergeMethods = { merge: false, squash: false, rebase: false };

    const error = await refused(setup, setup.merge(), {
      status: 409,
      code: "not_mergeable",
      rule: "Cronk merges only a Pull Request GitHub says is mergeable.",
    });
    expect(error.message).toBe("GitHub refused to merge cronkcorp/cronker#7: Merge commits are not allowed on this repository.");
    expect(error.advice).toBe(
      "Finish with needs you, asking in your Question for what GitHub needs before cronkcorp/cronker#7 can be merged.",
    );
  });

  test("a Run of a Step that isn't a Merge Step, and anyone but the Run's own Agent", async () => {
    const setup = await mergeRunning();
    const other = await ok("POST", `/api/projects/${setup.project.id}/tickets`, setup.ada, { title: "Something else" });
    await ok("PATCH", `/api/tickets/${other.id}`, setup.ada, {
      delegateId: setup.agent.id,
      autonomousDelegation: true,
      statusId: setup.status("Implement"),
    });
    const [implementRun] = await ok("GET", `/api/tickets/${other.id}/runs`, setup.ada);

    await refused(setup, call("POST", `/api/runs/${implementRun.id}/merge`, setup.asAgent, { pullRequestId: 501 }), {
      status: 403,
      code: "not_merge_step",
      rule: "Only a Run of a Merge Step merges its Ticket's Pull Request.",
    });
    const byAda = await setup.merge(setup.ada);
    expect([byAda.status, byAda.json.error.code]).toEqual([403, "not_runs_agent"]);
    expect(cronk.github.merges).toEqual([]);
  });
});

describe("the Merge Step's send-back Outcome", () => {
  test("sends a conflict back to Implement as a round; past its round limit *needs you* applies, with Cronk's Question", async () => {
    const setup = await mergeRunning();
    const { ada, project, ticket, status, finish, runningRun, workspace } = setup;
    const { step } = project.statuses.find((s: { name: string }) => s.name === "Merge");
    await ok("PUT", `/api/projects/${project.id}/statuses/${status("Merge")}/step`, ada, { ...step, roundLimit: 1 });
    setup.onGitHub.mergeable = false;
    expect((await setup.merge()).json.error.code).toBe("not_mergeable");

    await finish("send back");
    expect(await ok("GET", `/api/tickets/${ticket.id}`, ada)).toMatchObject({ statusId: status("Implement") });
    expect((await runningRun()).step.name).toBe("Implement");

    // The next round comes back to Merge, where the conflict is still there.
    await finish("done");
    await finish("approve");
    expect((await runningRun()).step.name).toBe("Merge");
    const last = await finish("send back");

    expect(last).toMatchObject({ state: "finished", outcome: "needs you", questionBy: "cronk" });
    expect(await ok("GET", `/api/tickets/${ticket.id}`, ada)).toMatchObject({ statusId: status("In Review") });
    const { items } = await ok("GET", `/api/workspaces/${workspace.id}/inbox`, ada);
    expect(items.map((i: { kind: string }) => i.kind)).toContain("needsYou");
  });
});

describe("the default Merge Step's Brief", () => {
  test("explains merge_pull_request, that a merge ends the Run, and sending conflicts and known failures back with a Comment", async () => {
    const { ada, ticket } = await mergeRunning();

    const brief = await ok("GET", `/api/tickets/${ticket.id}/brief`, ada);

    expect(brief.brief).toContain("`merge_pull_request`");
    expect(brief.brief).toContain("**send back**");
    expect(brief.brief).toMatch(/merge conflict/);
    expect(brief.brief).toMatch(/Comment/);
    expect(brief.preamble).toContain(
      "- Call `finish` exactly once, as the last thing you do, unless you merge: a merge with `merge_pull_request` " +
        "ends this Run, finished as *merged*, so don't call `finish` after it.",
    );
  });

  test("an ordinary Step's preamble says nothing of merging through Cronk", async () => {
    const { ada, project, status } = await mergeRunning();
    const other = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Something else" });
    await ok("PATCH", `/api/tickets/${other.id}`, ada, { statusId: status("Implement") });

    expect((await ok("GET", `/api/tickets/${other.id}/brief`, ada)).preamble).not.toContain("merge_pull_request");
  });
});

describe("a merge and GitHub's own delivery of it", () => {
  test("when GitHub's delivery of the merge reaches Cronk before GitHub answers the merge, the merge is still the Agent's", async () => {
    const { merge, ada, ticket, status, run, agent, deliver, pullRequest } = await mergeRunning();
    let delivered: Promise<void> | undefined;
    cronk.github.onMerge = async () => {
      delivered = deliver("pull_request", {
        action: "closed",
        pull_request: { ...pullRequest, state: "closed", merged: true, merged_by: { login: "cronk-app[bot]", id: 4242, type: "Bot" }, updated_at: "2026-01-01T09:05:00Z" },
      });
      await delivered;
    };

    const merged = await merge();

    expect(merged.json).toMatchObject({ state: "finished", outcome: "merged" });
    await delivered;
    expect(await ok("GET", `/api/tickets/${ticket.id}`, ada)).toMatchObject({ statusId: status("Done"), verification: "unverified" });
    const timeline = await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada);
    expect(timeline.filter((c: { field: string }) => c.field === "merged")).toEqual([
      expect.objectContaining({ actor: expect.objectContaining({ kind: "agent", id: agent.id }), runId: run.id }),
    ]);
  });

  test("a Ticket of another Workspace the Pull Request links completes as Cronk's, not naming this Workspace's Agent", async () => {
    const setup = await mergeRunning();
    const { ada, cronker, merge } = setup;
    const friends = await ok("POST", "/api/workspaces", ada, { name: "Friends" });
    const theirs = await ok("POST", `/api/workspaces/${friends.id}/projects`, ada, { name: "Their Cronker", key: "CRONK" });
    await ok("POST", `/api/projects/${theirs.id}/repositories`, ada, { id: cronker.id });
    const theirTicket = await ok("POST", `/api/projects/${theirs.id}/tickets`, ada, { title: "Theirs" });
    await setup.deliver("pull_request", { action: "edited", pull_request: { ...setup.pullRequest, updated_at: "2026-01-01T09:01:00Z" } });
    expect((await ok("GET", `/api/tickets/${theirTicket.id}/pull-requests`, ada)).map((p: { id: number }) => p.id)).toEqual([501]);

    expect((await merge()).status).toBe(200);

    const done = theirs.statuses.find((s: { name: string }) => s.name === "Done").id;
    expect(await ok("GET", `/api/tickets/${theirTicket.id}`, ada)).toMatchObject({ statusId: done, verification: "unverified" });
    const timeline = await ok("GET", `/api/tickets/${theirTicket.id}/timeline`, ada);
    expect(timeline.filter((c: { field: string }) => ["merged", "status", "verification"].includes(c.field))).toEqual(
      ["merged", "status", "verification"].map((field) =>
        expect.objectContaining({ field, actor: { kind: "cronk", name: "Cronk" }, runId: null }),
      ),
    );
  });
});
