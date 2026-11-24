import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { minutes } from "../harness/clock.js";
import { createGitHubApp, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";
import { openMachineStream, type OpenStream } from "../harness/stream.js";

/**
 * Seam 1 for local Runs: a real Cronk with the `local` Runner kind, and the daemon played over HTTP with a Machine
 * token. Delegating starts a claimable Run, a Machine claims it once, heartbeats it and reports how it ended.
 */

let cronk: StartedCronk;
const streams: OpenStream[] = [];
beforeEach(async () => {
  cronk = await startCronk();
});
afterEach(async () => {
  streams.splice(0).forEach((s) => s.close());
  await cronk?.stop();
});

type Options = { cookie?: string; body?: unknown; token?: string };

async function call(method: string, path: string, options: Options = {}) {
  const response = await cronk.request(method, path, {
    cookie: options.cookie,
    body: options.body,
    headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
  });
  return { status: response.status, json: response.status === 204 ? null : await response.json() };
}

async function ok(method: string, path: string, options: Options = {}) {
  const response = await call(method, path, options);
  expect(response.status, `${method} ${path}: ${JSON.stringify(response.json)}`).toBeLessThan(300);
  return response.json;
}

async function pair(ada: string, runnerIds: string[], limit?: number) {
  const started = await ok("POST", "/api/machines/pairings", {
    body: { name: "ada-laptop", os: "linux", daemonVersion: "0.3.0", ...(limit ? { limit } : {}) },
  });
  await ok("POST", "/api/machines/pairings/approve", { cookie: ada, body: { userCode: started.userCode, runnerIds } });
  const paired = await ok("POST", "/api/machines/pairings/poll", { body: { deviceCode: started.deviceCode } });
  return paired.machineToken as string;
}

/** Ada with a `local` Runner, an Agent on it, a Project with Tickets, and a Machine serving the Runner. */
async function localSetUp({ runLimit = 1, machineLimit }: { runLimit?: number; machineLimit?: number } = {}) {
  const { workspace } = await setUp(cronk);
  const ada = await signIn(cronk);
  const runner = await ok("POST", "/api/runners", { cookie: ada, body: { name: "Laptop", kind: "local" } });
  if (runLimit !== 1) await ok("PATCH", `/api/runners/${runner.id}`, { cookie: ada, body: { runLimit } });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, { cookie: ada, body: { name: "laptop" } });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, { cookie: ada, body: { runnerId: runner.id } });
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, { cookie: ada, body: { name: "Cronker", key: "CRONK" } });
  const triage = project.statuses.find((s: { name: string }) => s.name === "Triage").id as string;
  const machineToken = await pair(ada, [runner.id], machineLimit);
  /** Files a Ticket and delegates it into Triage, answering its Run. */
  const delegate = async (title: string, labels: string[] = []) => {
    const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, { cookie: ada, body: { title, labels } });
    await ok("PATCH", `/api/tickets/${ticket.id}`, { cookie: ada, body: { delegateId: agent.id, statusId: triage } });
    const [run] = await ok("GET", `/api/tickets/${ticket.id}/runs`, { cookie: ada });
    return { ticket, run };
  };
  return { workspace, ada, runner, agent, project, machineToken, delegate };
}

const claim = (token: string, runId: string) => call("POST", `/api/machine/runs/${runId}/claim`, { token });

describe("claiming a local Run", () => {
  test("a connected Machine hears of the Run as it starts and claims it with what claude needs", async () => {
    const { ada, machineToken, delegate } = await localSetUp();
    const stream = await openMachineStream(cronk, machineToken);
    streams.push(stream);

    const { run } = await delegate("Touch the laptop", ["local-only"]);

    expect(run.state).toBe("running");
    expect(await stream.next()).toEqual({ type: "run.claimable", data: { runId: run.id } });
    const claimed = await claim(machineToken, run.id);
    expect(claimed.status).toBe(200);
    const brief = await ok("GET", `/api/runs/${run.id}/brief`, { cookie: ada });
    expect(claimed.json).toEqual({
      runId: run.id,
      ticketKey: "CRONK-1",
      brief: brief.text,
      modelId: "claude-haiku-5-5",
      token: expect.stringMatching(/^cronk_agent_/),
      mcpUrl: `${cronk.url}/mcp`,
      repositories: [],
    });
    // A Project listing no Repositories needs no GitHub App.
    expect(cronk.github.apiCalls).toEqual([]);
  });

  test("a Machine connecting later is told of the Runs already waiting", async () => {
    const { machineToken, delegate } = await localSetUp();
    const { run } = await delegate("Waiting");

    const stream = await openMachineStream(cronk, machineToken);
    streams.push(stream);

    expect(await stream.next()).toEqual({ type: "run.claimable", data: { runId: run.id } });
  });

  test("two claims of one Run grant it once", async () => {
    const { ada, runner, machineToken, delegate } = await localSetUp();
    const other = await pair(ada, [runner.id]);
    const { run } = await delegate("Race");

    const [first, second] = await Promise.all([claim(machineToken, run.id), claim(other, run.id)]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect([first, second].find((c) => c.status === 409)!.json.error.code).toBe("run_not_claimable");
    expect((await claim(machineToken, run.id)).status).toBe(409);
  });

  test("a Machine claims no more Runs at once than its limit", async () => {
    const { machineToken, delegate } = await localSetUp({ runLimit: 2, machineLimit: 1 });
    const { run: first } = await delegate("One");
    const { run: second } = await delegate("Two");
    expect(second.state).toBe("running");

    expect((await claim(machineToken, first.id)).status).toBe(200);
    const refused = await claim(machineToken, second.id);

    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe("machine_limit_reached");
  });

  test("a Machine can't claim a Run of a Runner it doesn't serve", async () => {
    const { ada, delegate } = await localSetUp();
    const elsewhere = await ok("POST", "/api/runners", { cookie: ada, body: { name: "Desktop", kind: "local" } });
    const stranger = await pair(ada, [elsewhere.id]);
    const { run } = await delegate("Not yours");

    expect((await claim(stranger, run.id)).status).toBe(404);
    expect((await claim("cronk_machine_nonsense", run.id)).status).toBe(401);
  });

  test("a Step whose model label has no model id is refused, saying why", async () => {
    const { workspace, ada, delegate } = await localSetUp();
    await ok("DELETE", `/api/workspaces/${workspace.id}/model-ids/haiku`, { cookie: ada });

    const { run } = await delegate("No model");

    const refused = await ok("GET", `/api/runs/${run.id}`, { cookie: ada });
    expect(refused.state).toBe("refused");
    expect(refused.endReason).toContain("no model id for the label haiku");
  });
});

describe("the Run's token", () => {
  test("acts as the Run's Agent, finishes the Run, and is revoked once it ends", async () => {
    const { ada, agent, machineToken, delegate } = await localSetUp();
    const { run } = await delegate("Finish me");
    const { token } = (await claim(machineToken, run.id)).json;

    expect((await ok("GET", "/api/agent", { token })).agent.id).toBe(agent.id);
    const finished = await ok("POST", `/api/runs/${run.id}/finish`, { token, body: { outcome: "ready" } });
    expect(finished.state).toBe("finished");

    await cronk.jobsSettled();
    expect((await call("GET", "/api/agent", { token })).status).toBe(401);
    // The process exiting afterwards changes nothing.
    await ok("POST", `/api/machine/runs/${run.id}/end`, { token: machineToken, body: { reason: "claude exited with code 0" } });
    expect((await ok("GET", `/api/runs/${run.id}`, { cookie: ada })).state).toBe("finished");
  });

  test("is revoked when a User takes the Ticket away, and the heartbeat says the Run stopped", async () => {
    const { ada, machineToken, delegate } = await localSetUp();
    const { ticket, run } = await delegate("Take it back");
    const { token } = (await claim(machineToken, run.id)).json;

    await ok("PATCH", `/api/tickets/${ticket.id}`, { cookie: ada, body: { delegateId: null } });
    await cronk.jobsSettled();

    expect((await call("GET", "/api/agent", { token })).status).toBe(401);
    const beat = await call("POST", `/api/machine/runs/${run.id}/heartbeat`, { token: machineToken });
    expect(beat.status).toBe(409);
    expect(beat.json.error.code).toBe("run_stopped");
  });
});

describe("a claimed Run", () => {
  test("takes the session id the daemon reports while it runs, and none after", async () => {
    const { machineToken, delegate } = await localSetUp();
    const { run } = await delegate("Session");
    await claim(machineToken, run.id);
    const report = () => call("POST", `/api/machine/runs/${run.id}/session`, { token: machineToken, body: { sessionId: "4f1c2b9e" } });

    expect((await report()).status).toBe(204);
    await ok("POST", `/api/machine/runs/${run.id}/end`, { token: machineToken, body: { reason: "claude exited with code 1" } });
    expect((await report()).json.error.code).toBe("run_stopped");
  });

  test("whose Machine reports its end while it is lost is told it may yet come back, until its Ticket moves on", async () => {
    const { ada, machineToken, delegate } = await localSetUp();
    const { ticket, run } = await delegate("Napping");
    await claim(machineToken, run.id);
    cronk.clock.advance(minutes(40));
    await cronk.checkForLostRuns();
    expect((await ok("GET", `/api/runs/${run.id}`, { cookie: ada })).state).toBe("lost");
    const end = () => ok("POST", `/api/machine/runs/${run.id}/end`, { token: machineToken, body: { reason: "claude exited with code 0" } });

    expect(await end()).toEqual({ mayComeBack: true });
    expect((await ok("GET", `/api/runs/${run.id}`, { cookie: ada })).state).toBe("lost");

    await ok("PATCH", `/api/tickets/${ticket.id}`, { cookie: ada, body: { delegateId: null } });
    expect(await end()).toEqual({ mayComeBack: false });
  });

  test("heartbeats keep it running past the lost-Run threshold; without them it is lost", async () => {
    const { ada, machineToken, delegate } = await localSetUp({ runLimit: 2 });
    const { run: beating } = await delegate("Beating");
    const { run: silent } = await delegate("Silent");
    await claim(machineToken, beating.id);
    await claim(machineToken, silent.id);

    for (let i = 0; i < 4; i++) {
      cronk.clock.advance(minutes(10));
      await ok("POST", `/api/machine/runs/${beating.id}/heartbeat`, { token: machineToken });
      await cronk.checkForLostRuns();
    }

    expect((await ok("GET", `/api/runs/${beating.id}`, { cookie: ada })).state).toBe("running");
    expect((await ok("GET", `/api/runs/${silent.id}`, { cookie: ada })).state).toBe("lost");
  });

  test("whose process exits without finish fails with the reason, and its token is revoked", async () => {
    const { ada, machineToken, delegate } = await localSetUp();
    const { run } = await delegate("Crash");
    const { token } = (await claim(machineToken, run.id)).json;

    await ok("POST", `/api/machine/runs/${run.id}/end`, { token: machineToken, body: { reason: "claude exited with code 1" } });
    await cronk.jobsSettled();

    expect(await ok("GET", `/api/runs/${run.id}`, { cookie: ada })).toEqual(
      expect.objectContaining({ state: "failed", endReason: "The session ended without calling `finish`: claude exited with code 1" }),
    );
    expect((await call("GET", "/api/agent", { token })).status).toBe(401);
  });

  test("only the Machine that claimed it reports on it", async () => {
    const { ada, runner, machineToken, delegate } = await localSetUp();
    const other = await pair(ada, [runner.id]);
    const { run } = await delegate("Mine");
    await claim(machineToken, run.id);

    for (const path of ["heartbeat", "end"]) {
      const response = await call("POST", `/api/machine/runs/${run.id}/${path}`, { token: other, body: { reason: "no" } });
      expect(response.status).toBe(404);
    }
    expect((await ok("GET", `/api/runs/${run.id}`, { cookie: ada })).state).toBe("running");
  });
});

describe("a local Run's Repositories", () => {
  /** The local set-up, with the GitHub App installed on cronkcorp's cronker and website, both listed by the Project. */
  async function withRepositories() {
    const setup = await localSetUp();
    await createGitHubApp(cronk, setup.ada);
    const app = cronk.github.apps[0]!;
    const installation = cronk.github.install(app, "cronkcorp", ["cronker", "website"]);
    for (const repository of installation.repositories) {
      await ok("POST", `/api/projects/${setup.project.id}/repositories`, { cookie: setup.ada, body: { id: repository.id } });
    }
    /** Opens a Pull Request on the Repository for the Ticket, by its key in the title, as GitHub tells Cronk of it. */
    const openPullRequest = async (repository: (typeof installation.repositories)[number], number: number, title: string, branch: string, updatedAt: string) => {
      const delivered = await cronk.github.deliver(app, "pull_request", {
        action: "opened",
        installation: { id: installation.id },
        repository: { id: repository.id, full_name: repository.fullName },
        pull_request: {
          id: repository.id * 1000 + number,
          number,
          title,
          state: "open",
          draft: false,
          merged: false,
          merged_by: null,
          auto_merge: null,
          html_url: `https://github.com/${repository.fullName}/pull/${number}`,
          head: { ref: branch, sha: "aaaa" },
          updated_at: updatedAt,
        },
      });
      expect(delivered.status, await delivered.clone().text()).toBe(200);
    };
    return { ...setup, installation, openPullRequest };
  }

  /** The installation tokens GitHub issued that are still good, by the test's clock. */
  const goodTokens = () =>
    cronk.github.tokensIssued.filter((t) => t.expiresAt.getTime() > cronk.clock.now().getTime()).map((t) => t.token);

  test("come with the claim, each with its clone URL, a fresh App token, and no start branch for a Ticket without one", async () => {
    const { machineToken, delegate, installation } = await withRepositories();
    const { run } = await delegate("Change the code");

    const { repositories } = (await claim(machineToken, run.id)).json;

    expect(repositories).toEqual([
      { fullName: "cronkcorp/cronker", cloneUrl: `${cronk.github.url}/cronkcorp/cronker`, startBranch: null, token: expect.any(String), expiresAt: expect.any(String) },
      { fullName: "cronkcorp/website", cloneUrl: `${cronk.github.url}/cronkcorp/website`, startBranch: null, token: expect.any(String), expiresAt: expect.any(String) },
    ]);
    for (const { token, expiresAt } of repositories) {
      const issued = cronk.github.tokensIssued.find((t) => t.token === token);
      expect(issued?.installationId).toBe(installation.id);
      expect(issued?.expiresAt.toISOString()).toBe(expiresAt);
      expect(goodTokens()).toContain(token);
    }
  });

  test("start on the branch of the Ticket's open Pull Request in each, the most recently updated", async () => {
    const { machineToken, delegate, installation, openPullRequest } = await withRepositories();
    const [cronker, website] = installation.repositories;
    const { run } = await delegate("Carry on");
    await openPullRequest(cronker!, 7, "CRONK-1: first go", "feat/CRONK-1-first", "2026-01-01T09:00:00Z");
    await openPullRequest(cronker!, 8, "CRONK-1: second go", "feat/CRONK-1-second", "2026-01-02T09:00:00Z");
    await openPullRequest(website!, 3, "CRONK-2: another Ticket's", "feat/CRONK-2-other", "2026-01-03T09:00:00Z");

    const { repositories } = (await claim(machineToken, run.id)).json;

    expect(repositories.map((r: { fullName: string; startBranch: string | null }) => [r.fullName, r.startBranch])).toEqual([
      ["cronkcorp/cronker", "feat/CRONK-1-second"],
      ["cronkcorp/website", null],
    ]);
  });

  test("get fresh tokens from a heartbeat once theirs near their expiry, and none before", async () => {
    const { machineToken, delegate } = await withRepositories();
    const { run } = await delegate("Long work");
    const claimed = (await claim(machineToken, run.id)).json;
    const first = claimed.repositories.map((r: { token: string }) => r.token);
    const beat = () => ok("POST", `/api/machine/runs/${run.id}/heartbeat`, { token: machineToken });

    cronk.clock.advance(minutes(30));
    expect(await beat()).toEqual({ repositories: [] });

    cronk.clock.advance(minutes(21));
    const { repositories } = await beat();
    expect(repositories.map((r: { fullName: string }) => r.fullName)).toEqual(["cronkcorp/cronker", "cronkcorp/website"]);
    for (const { token } of repositories) {
      expect(first).not.toContain(token);
      expect(goodTokens()).toContain(token);
    }
    expect(await beat()).toEqual({ repositories: [] });

    // The fresh tokens are still good once the first expire, and keep being renewed.
    cronk.clock.advance(minutes(50));
    const again = await beat();
    expect(again.repositories).toHaveLength(2);
    cronk.clock.advance(minutes(15));
    for (const { token } of again.repositories) expect(goodTokens()).toContain(token);
  });

  test("that the GitHub App no longer covers fail the Run on its claim, saying which", async () => {
    const { ada, machineToken, delegate, installation } = await withRepositories();
    installation.repositories.splice(0, 1);
    // What GitHub said the installation covers is kept for five minutes.
    cronk.clock.advance(minutes(6));
    const { run } = await delegate("Can't reach it");

    const refused = await claim(machineToken, run.id);

    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe("repositories_unavailable");
    const failed = await ok("GET", `/api/runs/${run.id}`, { cookie: ada });
    expect(failed.state).toBe("failed");
    expect(failed.endReason).toContain("cronkcorp/cronker");
  });
});
