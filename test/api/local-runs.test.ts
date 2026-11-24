import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { defaultAllowedTools } from "../../server/runs/allowlist.js";
import { minutes } from "../harness/clock.js";
import { createGitHubApp, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";
import {
  openMachineStream,
  openRunnerStream,
  type OpenStream,
} from "../harness/stream.js";

/**
 * Seam 1 for local Runs: a real Cronk with the `local` Runner kind, and the daemon played over HTTP with a Machine
 * token. Delegating starts a claimable Run while a Machine serving its Runner is connected, a Machine claims it once,
 * heartbeats it and reports how it ended.
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

type CallOptions = Options & { headers?: Record<string, string> };

async function call(method: string, path: string, options: CallOptions = {}) {
  const response = await cronk.request(method, path, {
    cookie: options.cookie,
    body: options.body,
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
  });
  return {
    status: response.status,
    json: response.status === 204 ? null : await response.json(),
  };
}

async function ok(method: string, path: string, options: CallOptions = {}) {
  const response = await call(method, path, options);
  expect(
    response.status,
    `${method} ${path}: ${JSON.stringify(response.json)}`,
  ).toBeLessThan(300);
  return response.json;
}

async function pair(
  ada: string,
  runnerIds: string[],
  limit?: number,
  name = "ada-laptop",
) {
  const started = await ok("POST", "/api/machines/pairings", {
    body: {
      name,
      os: "linux",
      daemonVersion: "0.3.0",
      ...(limit ? { limit } : {}),
    },
  });
  await ok("POST", "/api/machines/pairings/approve", {
    cookie: ada,
    body: { userCode: started.userCode, runnerIds },
  });
  const paired = await ok("POST", "/api/machines/pairings/poll", {
    body: { deviceCode: started.deviceCode },
  });
  return paired.machineToken as string;
}

/** Opens the Machine's event stream, as its daemon does, closed after the test. */
async function connect(machineToken: string) {
  const stream = await openMachineStream(cronk, machineToken);
  streams.push(stream);
  return stream;
}

/**
 * Ada with a `local` Runner, an Agent on it, a Project with Tickets, and a Machine serving the Runner, connected unless
 * the test says otherwise.
 */
async function localSetUp({
  runLimit = 1,
  machineLimit,
  connected = true,
}: { runLimit?: number; machineLimit?: number; connected?: boolean } = {}) {
  const { workspace } = await setUp(cronk);
  const ada = await signIn(cronk);
  const runner = await ok("POST", "/api/runners", {
    cookie: ada,
    body: { name: "Laptop", kind: "local" },
  });
  if (runLimit !== 1)
    await ok("PATCH", `/api/runners/${runner.id}`, {
      cookie: ada,
      body: { limit: runLimit },
    });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, {
    cookie: ada,
    body: { name: "laptop" },
  });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, {
    cookie: ada,
    body: { runnerId: runner.id },
  });
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, {
    cookie: ada,
    body: { name: "Cronker", key: "CRONK" },
  });
  const triage = project.statuses.find(
    (s: { name: string }) => s.name === "Triage",
  ).id as string;
  const machineToken = await pair(ada, [runner.id], machineLimit);
  if (connected) await connect(machineToken);
  /** Files a Ticket and delegates it into Triage, answering its Run, if it got one. */
  const delegate = async (
    title: string,
    { labels = [], priority }: { labels?: string[]; priority?: string } = {},
  ) => {
    const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, {
      cookie: ada,
      body: { title, labels },
    });
    if (priority)
      await ok("PATCH", `/api/tickets/${ticket.id}`, {
        cookie: ada,
        body: { priority },
      });
    await ok("PATCH", `/api/tickets/${ticket.id}`, {
      cookie: ada,
      body: { delegateId: agent.id, statusId: triage },
    });
    const [run] = await ok("GET", `/api/tickets/${ticket.id}/runs`, {
      cookie: ada,
    });
    return { ticket, run };
  };
  const runsOf = (ticketId: string) =>
    ok("GET", `/api/tickets/${ticketId}/runs`, { cookie: ada });
  const runnerRecord = async () =>
    (await ok("GET", "/api/runners", { cookie: ada })).find(
      (r: { id: string }) => r.id === runner.id,
    );
  return {
    workspace,
    ada,
    runner,
    agent,
    project,
    machineToken,
    delegate,
    runsOf,
    runnerRecord,
  };
}

/** Waits until the check passes, as a stream's close reaches the server on its own time. */
async function eventually(
  check: () => Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const claim = (token: string, runId: string) =>
  call("POST", `/api/machine/runs/${runId}/claim`, { token });

describe("claiming a local Run", () => {
  test("a connected Machine hears of the Run as it starts and claims it with what claude needs", async () => {
    const { ada, machineToken, delegate } = await localSetUp();
    const stream = await connect(machineToken);

    const { run } = await delegate("Touch the laptop", {
      labels: ["local-only"],
    });

    expect(run.state).toBe("running");
    expect(await stream.next()).toEqual({
      type: "run.claimable",
      data: { runId: run.id },
    });
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
      allowedTools: [...defaultAllowedTools],
    });
    // A Project listing no Repositories needs no GitHub App.
    expect(cronk.github.apiCalls).toEqual([]);
  });

  test("a Machine connecting is told of the Runs already waiting to be claimed", async () => {
    const { machineToken, delegate } = await localSetUp();
    const { run } = await delegate("Waiting");

    const stream = await connect(machineToken);

    expect(await stream.next()).toEqual({
      type: "run.claimable",
      data: { runId: run.id },
    });
  });

  test("two claims of one Run grant it once", async () => {
    const { ada, runner, machineToken, delegate } = await localSetUp();
    const other = await pair(ada, [runner.id]);
    const { run } = await delegate("Race");

    const [first, second] = await Promise.all([
      claim(machineToken, run.id),
      claim(other, run.id),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect([first, second].find((c) => c.status === 409)!.json.error.code).toBe(
      "run_not_claimable",
    );
    expect((await claim(machineToken, run.id)).status).toBe(409);
  });

  test("a Machine claims no more Runs at once than its limit", async () => {
    const { machineToken, delegate } = await localSetUp({
      runLimit: 2,
      machineLimit: 1,
    });
    const { run: first } = await delegate("One");
    const { run: second } = await delegate("Two");
    expect(second.state).toBe("running");

    expect((await claim(machineToken, first.id)).status).toBe(200);
    const refused = await claim(machineToken, second.id);

    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe("machine_limit_reached");
  });

  test("a Runner whose limit was lowered gets no more Runs claimed than it until one ends", async () => {
    const { ada, runner, machineToken, delegate } = await localSetUp({
      runLimit: 2,
      machineLimit: 5,
    });
    const { run: first } = await delegate("One");
    const { run: second } = await delegate("Two");
    await ok("PATCH", `/api/runners/${runner.id}`, {
      cookie: ada,
      body: { limit: 1 },
    });

    expect((await claim(machineToken, first.id)).status).toBe(200);
    const refused = await claim(machineToken, second.id);
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe("runner_limit_reached");

    await ok("POST", `/api/machine/runs/${first.id}/end`, {
      token: machineToken,
      body: { reason: "claude exited with code 0" },
    });
    expect((await claim(machineToken, second.id)).status).toBe(200);
  });

  test("a Machine at its limit claims again once one of its Runs ends", async () => {
    const { machineToken, delegate } = await localSetUp({
      runLimit: 2,
      machineLimit: 1,
    });
    const { run: first } = await delegate("One");
    const { run: second } = await delegate("Two");
    await claim(machineToken, first.id);
    expect((await claim(machineToken, second.id)).json.error.code).toBe(
      "machine_limit_reached",
    );

    await ok("POST", `/api/machine/runs/${first.id}/end`, {
      token: machineToken,
      body: { reason: "claude exited with code 0" },
    });

    expect((await claim(machineToken, second.id)).status).toBe(200);
  });

  test("a Machine can't claim a Run of a Runner it doesn't serve", async () => {
    const { ada, delegate } = await localSetUp();
    const elsewhere = await ok("POST", "/api/runners", {
      cookie: ada,
      body: { name: "Desktop", kind: "local" },
    });
    const stranger = await pair(ada, [elsewhere.id]);
    const { run } = await delegate("Not yours");

    expect((await claim(stranger, run.id)).status).toBe(404);
    expect((await claim("cronk_machine_nonsense", run.id)).status).toBe(401);
  });

  test("a Step whose model label has no model id is refused, saying why", async () => {
    const { workspace, ada, delegate } = await localSetUp();
    await ok("DELETE", `/api/workspaces/${workspace.id}/model-ids/haiku`, {
      cookie: ada,
    });

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
    const finished = await ok("POST", `/api/runs/${run.id}/finish`, {
      token,
      body: { outcome: "ready" },
    });
    expect(finished.state).toBe("finished");

    await cronk.jobsSettled();
    expect((await call("GET", "/api/agent", { token })).status).toBe(401);
    // The process exiting afterwards changes nothing.
    await ok("POST", `/api/machine/runs/${run.id}/end`, {
      token: machineToken,
      body: { reason: "claude exited with code 0" },
    });
    expect(
      (await ok("GET", `/api/runs/${run.id}`, { cookie: ada })).state,
    ).toBe("finished");
  });

  test("is revoked when a User takes the Ticket away, and the heartbeat says the Run stopped", async () => {
    const { ada, machineToken, delegate } = await localSetUp();
    const { ticket, run } = await delegate("Take it back");
    const { token } = (await claim(machineToken, run.id)).json;

    await ok("PATCH", `/api/tickets/${ticket.id}`, {
      cookie: ada,
      body: { delegateId: null },
    });
    await cronk.jobsSettled();

    expect((await call("GET", "/api/agent", { token })).status).toBe(401);
    const beat = await call("POST", `/api/machine/runs/${run.id}/heartbeat`, {
      token: machineToken,
    });
    expect(beat.status).toBe(409);
    expect(beat.json.error.code).toBe("run_stopped");
  });
});

describe("a claimed Run", () => {
  test("takes the session id the daemon reports while it runs, and none after", async () => {
    const { machineToken, delegate } = await localSetUp();
    const { run } = await delegate("Session");
    await claim(machineToken, run.id);
    const report = () =>
      call("POST", `/api/machine/runs/${run.id}/session`, {
        token: machineToken,
        body: { sessionId: "4f1c2b9e" },
      });

    expect((await report()).status).toBe(204);
    await ok("POST", `/api/machine/runs/${run.id}/end`, {
      token: machineToken,
      body: { reason: "claude exited with code 1" },
    });
    expect((await report()).json.error.code).toBe("run_stopped");
  });

  test("whose Machine reports its end while it is lost is told it may yet come back, until its Ticket moves on", async () => {
    const { ada, machineToken, delegate } = await localSetUp();
    const { ticket, run } = await delegate("Napping");
    await claim(machineToken, run.id);
    cronk.clock.advance(minutes(40));
    await cronk.checkForLostRuns();
    expect(
      (await ok("GET", `/api/runs/${run.id}`, { cookie: ada })).state,
    ).toBe("lost");
    const end = () =>
      ok("POST", `/api/machine/runs/${run.id}/end`, {
        token: machineToken,
        body: { reason: "claude exited with code 0" },
      });

    expect(await end()).toEqual({ mayComeBack: true });
    expect(
      (await ok("GET", `/api/runs/${run.id}`, { cookie: ada })).state,
    ).toBe("lost");

    await ok("PATCH", `/api/tickets/${ticket.id}`, {
      cookie: ada,
      body: { delegateId: null },
    });
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
      await ok("POST", `/api/machine/runs/${beating.id}/heartbeat`, {
        token: machineToken,
      });
      await cronk.checkForLostRuns();
    }

    expect(
      (await ok("GET", `/api/runs/${beating.id}`, { cookie: ada })).state,
    ).toBe("running");
    expect(
      (await ok("GET", `/api/runs/${silent.id}`, { cookie: ada })).state,
    ).toBe("lost");
  });

  test("whose process exits without finish fails with the reason, and its token is revoked", async () => {
    const { ada, machineToken, delegate } = await localSetUp();
    const { run } = await delegate("Crash");
    const { token } = (await claim(machineToken, run.id)).json;

    await ok("POST", `/api/machine/runs/${run.id}/end`, {
      token: machineToken,
      body: { reason: "claude exited with code 1" },
    });
    await cronk.jobsSettled();

    expect(await ok("GET", `/api/runs/${run.id}`, { cookie: ada })).toEqual(
      expect.objectContaining({
        state: "failed",
        endReason:
          "The session ended without calling `finish`: claude exited with code 1",
      }),
    );
    expect((await call("GET", "/api/agent", { token })).status).toBe(401);
  });

  test("only the Machine that claimed it reports on it", async () => {
    const { ada, runner, machineToken, delegate } = await localSetUp();
    const other = await pair(ada, [runner.id]);
    const { run } = await delegate("Mine");
    await claim(machineToken, run.id);

    for (const path of ["heartbeat", "end"]) {
      const response = await call(
        "POST",
        `/api/machine/runs/${run.id}/${path}`,
        { token: other, body: { reason: "no" } },
      );
      expect(response.status).toBe(404);
    }
    expect(
      (await ok("GET", `/api/runs/${run.id}`, { cookie: ada })).state,
    ).toBe("running");
  });
});

describe("an offline local Runner", () => {
  test("keeps its delegated Tickets waiting, refusing none, and starts them in Priority order once a Machine connects", async () => {
    const { ada, machineToken, delegate, runsOf } = await localSetUp({
      runLimit: 2,
      connected: false,
    });
    const low = await delegate("Low", { priority: "low" });
    const urgent = await delegate("Urgent", { priority: "urgent" });
    const high = await delegate("High", { priority: "high" });

    for (const { ticket, run } of [low, urgent, high]) {
      expect(run).toBeUndefined();
      expect(
        (await ok("GET", `/api/tickets/${ticket.id}`, { cookie: ada })).waiting,
      ).toBe("runnerOffline");
    }

    const stream = await connect(machineToken);

    const [urgentRun] = await runsOf(urgent.ticket.id);
    const [highRun] = await runsOf(high.ticket.id);
    expect(urgentRun.state).toBe("running");
    expect(highRun.state).toBe("running");
    expect(await runsOf(low.ticket.id)).toEqual([]);
    expect(
      (await ok("GET", `/api/tickets/${low.ticket.id}`, { cookie: ada }))
        .waiting,
    ).toBe("runnerSlot");
    expect(await stream.next()).toEqual({
      type: "run.claimable",
      data: { runId: urgentRun.id },
    });
    expect(await stream.next()).toEqual({
      type: "run.claimable",
      data: { runId: highRun.id },
    });
  });

  test("shows since when on its record, telling its Owner's stream as a Machine connects and goes", async () => {
    const { ada, runner, machineToken, runnerRecord } = await localSetUp({
      connected: false,
    });
    expect((await runnerRecord()).offlineSince).toBe(runner.createdAt);
    const runners = await openRunnerStream(cronk, ada);
    streams.push(runners);

    const machine = await connect(machineToken);

    expect(await runners.next()).toEqual({
      type: "runner.changed",
      data: { runnerId: runner.id },
    });
    expect((await runnerRecord()).offlineSince).toBeNull();
    const [shown] = await ok("GET", "/api/machines", { cookie: ada });
    expect(shown.connected).toBe(true);

    cronk.clock.advance(minutes(5));
    machine.close();

    expect(await runners.next()).toEqual({
      type: "runner.changed",
      data: { runnerId: runner.id },
    });
    expect((await runnerRecord()).offlineSince).toBe(
      cronk.clock.now().toISOString(),
    );
    const [gone] = await ok("GET", "/api/machines", { cookie: ada });
    expect(gone.connected).toBe(false);
  });

  test("stays online while another Machine serving it is connected", async () => {
    const { ada, runner, machineToken, runnerRecord } = await localSetUp({
      connected: false,
    });
    const desktop = await pair(ada, [runner.id], undefined, "ada-desktop");
    const laptop = await connect(machineToken);
    await connect(desktop);

    laptop.close();
    await eventually(async () => {
      const machines = await ok("GET", "/api/machines", { cookie: ada });
      return (
        machines.find((m: { name: string }) => m.name === "ada-laptop")
          .connected === false
      );
    });

    expect((await runnerRecord()).offlineSince).toBeNull();
  });

  test("leaves a Run told already claimable when its Machine goes", async () => {
    const { machineToken, delegate, runnerRecord } = await localSetUp({
      connected: false,
    });
    const machine = await connect(machineToken);
    const { run } = await delegate("Told");
    machine.close();
    await eventually(async () => (await runnerRecord()).offlineSince !== null);

    const back = await connect(machineToken);

    expect(await back.next()).toEqual({
      type: "run.claimable",
      data: { runId: run.id },
    });
    expect((await claim(machineToken, run.id)).status).toBe(200);
  });
});

describe("the daemon's version and limit", () => {
  test("a daemon too old for Cronk can't pair, told the version to upgrade to", async () => {
    const refused = await call("POST", "/api/machines/pairings", {
      body: { name: "old-laptop", os: "linux", daemonVersion: "0.2.9" },
    });

    expect(refused.status).toBe(426);
    expect(refused.json.error.code).toBe("daemon_too_old");
    expect(refused.json.error.message).toContain(
      "upgrade cronk-runner to 0.3.0",
    );
  });

  test("a paired Machine whose daemon announces an old version is refused, and its card says what to upgrade to", async () => {
    const { ada, machineToken } = await localSetUp({ connected: false });
    const old = { "x-cronk-runner-version": "0.2.0" };

    for (const [method, path] of [
      ["GET", "/api/machine"],
      ["GET", "/api/machine/events"],
    ] as const) {
      const refused = await call(method, path, {
        token: machineToken,
        headers: old,
      });
      expect(refused.status).toBe(426);
      expect(refused.json.error).toEqual({
        code: "daemon_too_old",
        message:
          "This Cronk works with cronk-runner 0.3.0 or later, and this Machine runs 0.2.0: upgrade cronk-runner to 0.3.0 or later, then start it again.",
      });
    }
    const [machine] = await ok("GET", "/api/machines", { cookie: ada });
    expect(machine).toEqual(
      expect.objectContaining({
        daemonVersion: "0.2.0",
        upgradeTo: "0.3.0",
        connected: false,
      }),
    );

    await ok("GET", "/api/machine", {
      token: machineToken,
      headers: { "x-cronk-runner-version": "0.3.1" },
    });
    const [upgraded] = await ok("GET", "/api/machines", { cookie: ada });
    expect(upgraded).toEqual(
      expect.objectContaining({ daemonVersion: "0.3.1", upgradeTo: null }),
    );
  });

  test("the limit a daemon announces replaces the one it paired with", async () => {
    const { ada, machineToken } = await localSetUp({ connected: false });

    await ok("GET", "/api/machine", {
      token: machineToken,
      headers: { "x-cronk-runner-limit": "4" },
    });

    const [machine] = await ok("GET", "/api/machines", { cookie: ada });
    expect(machine.limit).toBe(4);
  });
});

describe("stopping a local Run", () => {
  const stopped = (machineToken: string, runId: string) =>
    call("POST", `/api/machine/runs/${runId}/stopped`, { token: machineToken });

  test("a stop while the Machine is connected is told on its stream, and its confirmation is taken once or more", async () => {
    const { ada, machineToken, delegate } = await localSetUp();
    const stream = await openMachineStream(cronk, machineToken);
    streams.push(stream);
    const { ticket, run } = await delegate("Stop me");
    expect(await stream.next()).toEqual({
      type: "run.claimable",
      data: { runId: run.id },
    });
    await claim(machineToken, run.id);

    await ok("PATCH", `/api/tickets/${ticket.id}`, {
      cookie: ada,
      body: { delegateId: null },
    });

    expect(await stream.next()).toEqual({
      type: "run.stop",
      data: { runId: run.id },
    });
    expect((await stopped(machineToken, run.id)).status).toBe(204);
    expect((await stopped(machineToken, run.id)).status).toBe(204);
    // Confirmed, it isn't told again.
    const again = await openMachineStream(cronk, machineToken);
    streams.push(again);
    await again.expectQuiet();
  });

  test("a stop while the Machine is offline shows at once, and is told again on every connect until confirmed", async () => {
    const { ada, machineToken, delegate } = await localSetUp();
    const { ticket, run } = await delegate("Stop me offline");
    const { token } = (await claim(machineToken, run.id)).json;

    await ok("PATCH", `/api/tickets/${ticket.id}`, {
      cookie: ada,
      body: { delegateId: null },
    });
    await cronk.jobsSettled();

    expect(
      (await ok("GET", `/api/runs/${run.id}`, { cookie: ada })).state,
    ).toBe("stopped");
    expect((await call("GET", "/api/agent", { token })).status).toBe(401);
    for (let i = 0; i < 2; i++) {
      const stream = await openMachineStream(cronk, machineToken);
      streams.push(stream);
      expect(await stream.next()).toEqual({
        type: "run.stop",
        data: { runId: run.id },
      });
      stream.close();
    }
    await stopped(machineToken, run.id);
    const after = await openMachineStream(cronk, machineToken);
    streams.push(after);
    await after.expectQuiet();
  });

  test("a process reported ended confirms its stop", async () => {
    const { ada, machineToken, delegate } = await localSetUp();
    const { ticket, run } = await delegate("Ended");
    await claim(machineToken, run.id);
    await ok("PATCH", `/api/tickets/${ticket.id}`, {
      cookie: ada,
      body: { delegateId: null },
    });

    await ok("POST", `/api/machine/runs/${run.id}/end`, {
      token: machineToken,
      body: { reason: "claude was killed by SIGTERM" },
    });

    const stream = await openMachineStream(cronk, machineToken);
    streams.push(stream);
    await stream.expectQuiet();
    expect(
      (await ok("GET", `/api/runs/${run.id}`, { cookie: ada })).state,
    ).toBe("stopped");
  });

  test("another Machine can't confirm a Run's stop", async () => {
    const { ada, runner, machineToken, delegate } = await localSetUp();
    const other = await pair(ada, [runner.id]);
    const { run } = await delegate("Not yours to stop");
    await claim(machineToken, run.id);

    expect((await stopped(other, run.id)).status).toBe(404);
  });

  test("unpairing a Machine stops the Runs it holds and revokes their tokens", async () => {
    const { ada, runner, machineToken, delegate } = await localSetUp();
    const { run } = await delegate("Unpair me");
    const { token } = (await claim(machineToken, run.id)).json;
    const [machine] = await ok("GET", "/api/machines", { cookie: ada });

    await ok("DELETE", `/api/machines/${machine.id}`, { cookie: ada });
    await cronk.jobsSettled();

    const ended = await ok("GET", `/api/runs/${run.id}`, { cookie: ada });
    expect(ended.state).toBe("stopped");
    expect(ended.endReason).toBe(
      "ada-laptop, the Machine running it, was unpaired.",
    );
    expect((await call("GET", "/api/agent", { token })).status).toBe(401);
    // Its slot is free again.
    const [listed] = (await ok("GET", "/api/runners", { cookie: ada })).filter(
      (r: { id: string }) => r.id === runner.id,
    );
    expect(listed.running).toBe(0);
  });

  test("removing a local Runner stops its running Runs and tells the Machine", async () => {
    const { ada, runner, machineToken, delegate } = await localSetUp();
    const stream = await openMachineStream(cronk, machineToken);
    streams.push(stream);
    const { run } = await delegate("Remove my Runner");
    await stream.next();
    const { token } = (await claim(machineToken, run.id)).json;

    await ok("DELETE", `/api/runners/${runner.id}`, { cookie: ada });

    expect(await stream.next()).toEqual({
      type: "run.stop",
      data: { runId: run.id },
    });
    expect(
      (await ok("GET", `/api/runs/${run.id}`, { cookie: ada })).state,
    ).toBe("stopped");
    expect((await call("GET", "/api/agent", { token })).status).toBe(401);
  });
});

describe("a local Run whose Machine slept", () => {
  async function lostRun() {
    const set = await localSetUp();
    const { ticket, run } = await set.delegate("Asleep");
    const { token } = (await claim(set.machineToken, run.id)).json;
    cronk.clock.advance(minutes(120));
    await cronk.checkForLostRuns();
    await cronk.jobsSettled();
    expect(
      (await ok("GET", `/api/runs/${run.id}`, { cookie: set.ada })).state,
    ).toBe("lost");
    return { ...set, ticket, run, token };
  }

  test("goes lost without heartbeats, keeping its token, and a later heartbeat brings it back", async () => {
    const { ada, machineToken, run, token } = await lostRun();
    expect((await call("GET", "/api/agent", { token })).status).toBe(200);
    // A lost Run isn't told to stop: it may yet come back.
    const stream = await openMachineStream(cronk, machineToken);
    streams.push(stream);
    await stream.expectQuiet();

    expect(
      (
        await call("POST", `/api/machine/runs/${run.id}/heartbeat`, {
          token: machineToken,
        })
      ).status,
    ).toBe(200);

    const back = await ok("GET", `/api/runs/${run.id}`, { cookie: ada });
    expect(back.state).toBe("running");
    expect(back.endReason).toBeNull();
    const finished = await ok("POST", `/api/runs/${run.id}/finish`, {
      token,
      body: { outcome: "ready" },
    });
    expect(finished.state).toBe("finished");
  });

  test("whose Ticket moved on meanwhile is told to stop on waking, and its token is revoked", async () => {
    const { ada, machineToken, ticket, run, token } = await lostRun();
    await ok("PATCH", `/api/tickets/${ticket.id}`, {
      cookie: ada,
      body: { delegateId: null },
    });

    const beat = await call("POST", `/api/machine/runs/${run.id}/heartbeat`, {
      token: machineToken,
    });

    expect(beat.status).toBe(409);
    expect(beat.json.error.code).toBe("run_stopped");
    expect(
      (await ok("GET", `/api/runs/${run.id}`, { cookie: ada })).state,
    ).toBe("lost");
    expect((await call("GET", "/api/agent", { token })).status).toBe(401);
    // Told by the answer, it isn't told again on the stream.
    const stream = await openMachineStream(cronk, machineToken);
    streams.push(stream);
    await stream.expectQuiet();
  });
});

describe("a local Run's Repositories", () => {
  /** The local set-up, with the GitHub App installed on cronkcorp's cronker and website, both listed by the Project. */
  async function withRepositories() {
    const setup = await localSetUp();
    await createGitHubApp(cronk, setup.ada);
    const app = cronk.github.apps[0]!;
    const installation = cronk.github.install(app, "cronkcorp", [
      "cronker",
      "website",
    ]);
    for (const repository of installation.repositories) {
      await ok("POST", `/api/projects/${setup.project.id}/repositories`, {
        cookie: setup.ada,
        body: { id: repository.id },
      });
    }
    /** Opens a Pull Request on the Repository for the Ticket, by its key in the title, as GitHub tells Cronk of it. */
    const openPullRequest = async (
      repository: (typeof installation.repositories)[number],
      number: number,
      title: string,
      branch: string,
      updatedAt: string,
    ) => {
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
    cronk.github.tokensIssued
      .filter((t) => t.expiresAt.getTime() > cronk.clock.now().getTime())
      .map((t) => t.token);

  test("come with the claim, each with its clone URL, a fresh App token, and no start branch for a Ticket without one", async () => {
    const { machineToken, delegate, installation } = await withRepositories();
    const { run } = await delegate("Change the code");

    const { repositories } = (await claim(machineToken, run.id)).json;

    expect(repositories).toEqual([
      {
        fullName: "cronkcorp/cronker",
        cloneUrl: `${cronk.github.url}/cronkcorp/cronker`,
        startBranch: null,
        token: expect.any(String),
        expiresAt: expect.any(String),
      },
      {
        fullName: "cronkcorp/website",
        cloneUrl: `${cronk.github.url}/cronkcorp/website`,
        startBranch: null,
        token: expect.any(String),
        expiresAt: expect.any(String),
      },
    ]);
    for (const { token, expiresAt } of repositories) {
      const issued = cronk.github.tokensIssued.find((t) => t.token === token);
      expect(issued?.installationId).toBe(installation.id);
      expect(issued?.expiresAt.toISOString()).toBe(expiresAt);
      expect(goodTokens()).toContain(token);
    }
  });

  test("start on the branch of the Ticket's open Pull Request in each, the most recently updated", async () => {
    const { machineToken, delegate, installation, openPullRequest } =
      await withRepositories();
    const [cronker, website] = installation.repositories;
    const { run } = await delegate("Carry on");
    await openPullRequest(
      cronker!,
      7,
      "CRONK-1: first go",
      "feat/CRONK-1-first",
      "2026-01-01T09:00:00Z",
    );
    await openPullRequest(
      cronker!,
      8,
      "CRONK-1: second go",
      "feat/CRONK-1-second",
      "2026-01-02T09:00:00Z",
    );
    await openPullRequest(
      website!,
      3,
      "CRONK-2: another Ticket's",
      "feat/CRONK-2-other",
      "2026-01-03T09:00:00Z",
    );

    const { repositories } = (await claim(machineToken, run.id)).json;

    expect(
      repositories.map(
        (r: { fullName: string; startBranch: string | null }) => [
          r.fullName,
          r.startBranch,
        ],
      ),
    ).toEqual([
      ["cronkcorp/cronker", "feat/CRONK-1-second"],
      ["cronkcorp/website", null],
    ]);
  });

  test("get fresh tokens from a heartbeat once theirs near their expiry, and none before", async () => {
    const { machineToken, delegate } = await withRepositories();
    const { run } = await delegate("Long work");
    const claimed = (await claim(machineToken, run.id)).json;
    const first = claimed.repositories.map((r: { token: string }) => r.token);
    const beat = () =>
      ok("POST", `/api/machine/runs/${run.id}/heartbeat`, {
        token: machineToken,
      });

    cronk.clock.advance(minutes(30));
    expect(await beat()).toEqual({ repositories: [] });

    cronk.clock.advance(minutes(21));
    const { repositories } = await beat();
    expect(repositories.map((r: { fullName: string }) => r.fullName)).toEqual([
      "cronkcorp/cronker",
      "cronkcorp/website",
    ]);
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
    for (const { token } of again.repositories)
      expect(goodTokens()).toContain(token);
  });

  test("that the GitHub App no longer covers fail the Run on its claim, saying which", async () => {
    const { ada, machineToken, delegate, installation } =
      await withRepositories();
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

describe("a local Runner's allowlist", () => {
  test("a new local Runner has the default, which includes git, package managers, test runners and Cronk's tools", async () => {
    const { runner } = await localSetUp();

    expect(runner.allowedTools).toEqual([...defaultAllowedTools]);
    expect(runner.allowedTools).toEqual(
      expect.arrayContaining([
        "Bash(git:*)",
        "Bash(npm:*)",
        "Bash(pytest:*)",
        "mcp__cronk",
      ]),
    );
  });

  test("its User edits it, trimmed and without repeats, and it applies to the Runs claimed from then on", async () => {
    const { ada, runner, machineToken, delegate } = await localSetUp({
      runLimit: 2,
      machineLimit: 2,
    });
    const { run: before } = await delegate("Before");
    const beforeClaim = await claim(machineToken, before.id);

    const { run: after } = await delegate("After");
    const edited = await ok("PATCH", `/api/runners/${runner.id}`, {
      cookie: ada,
      body: {
        allowedTools: [" Bash(git:*) ", "Bash(cargo test:*)", "Bash(git:*)"],
      },
    });

    expect(edited.allowedTools).toEqual(["Bash(git:*)", "Bash(cargo test:*)"]);
    expect(
      (await ok("GET", "/api/runners", { cookie: ada }))[0].allowedTools,
    ).toEqual(["Bash(git:*)", "Bash(cargo test:*)"]);
    expect(beforeClaim.json.allowedTools).toEqual([...defaultAllowedTools]);
    expect((await claim(machineToken, after.id)).json.allowedTools).toEqual([
      "Bash(git:*)",
      "Bash(cargo test:*)",
    ]);

    const reset = await ok("PATCH", `/api/runners/${runner.id}`, {
      cookie: ada,
      body: { allowedTools: null },
    });
    expect(reset.allowedTools).toEqual([...defaultAllowedTools]);
  });

  test("an empty or overlong rule is refused, and a Runner of another kind has none", async () => {
    const { ada, runner } = await localSetUp();
    for (const allowedTools of [
      [" "],
      ["x".repeat(201)],
      Array.from({ length: 201 }, (_, i) => `Bash(tool${i}:*)`),
    ]) {
      const refused = await call("PATCH", `/api/runners/${runner.id}`, {
        cookie: ada,
        body: { allowedTools },
      });
      expect(refused.status).toBe(400);
    }

    const cloud = await ok("POST", "/api/runners", {
      cookie: ada,
      body: { name: "Max", kind: "subscription" },
    });
    expect(cloud.allowedTools).toBeNull();
    const refused = await call("PATCH", `/api/runners/${cloud.id}`, {
      cookie: ada,
      body: { allowedTools: ["Bash(git:*)"] },
    });
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe("runner_has_no_allowlist");
  });

  test("a Run whose process ended on tools outside the list fails naming them", async () => {
    const { ada, machineToken, delegate } = await localSetUp();
    const { run } = await delegate("Publish");
    await claim(machineToken, run.id);

    await ok("POST", `/api/machine/runs/${run.id}/end`, {
      token: machineToken,
      body: {
        reason: "claude exited with code 0",
        deniedTools: ["Bash(npm publish)", "WebFetch"],
      },
    });
    await cronk.jobsSettled();

    expect(
      (await ok("GET", `/api/runs/${run.id}`, { cookie: ada })).endReason,
    ).toBe(
      "The session ended without calling `finish`: claude exited with code 0. It needed tools outside the Runner's " +
        "allowlist: Bash(npm publish), WebFetch; widen the allowlist and Retry.",
    );
  });
});

/** A Claude Code transcript of `count` user messages, its JSONL file as it is. */
const jsonl = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    JSON.stringify({
      type: "user",
      uuid: `u-${i}`,
      timestamp: "2026-01-01T09:00:00.000Z",
      message: { role: "user", content: `Message ${i}.` },
    }),
  ).join("\n") + "\n";

/** Uploads a claimed Run's transcript with the Machine token, as the daemon does. */
async function uploadTranscript(token: string, runId: string, body: string) {
  const response = await fetch(
    `${cronk.url}/api/machine/runs/${runId}/transcript`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/x-ndjson",
        authorization: `Bearer ${token}`,
      },
      body,
    },
  );
  return { status: response.status, json: await response.json() };
}

describe("a local Run's transcript", () => {
  test("uploaded by its Machine becomes the Run's Transcript, replaced by each later upload, even after the Run ended", async () => {
    const { ada, agent, machineToken, delegate } = await localSetUp();
    const { run } = await delegate("Transcribe me");
    const { token } = (await claim(machineToken, run.id)).json;
    await ok("POST", `/api/machine/runs/${run.id}/session`, {
      token: machineToken,
      body: { sessionId: "4f1c2b9e" },
    });

    const first = await uploadTranscript(machineToken, run.id, jsonl(1));
    expect(first.status).toBe(201);
    expect(first.json).toEqual(
      expect.objectContaining({
        runId: run.id,
        entryCount: 1,
        agent: { id: agent.id, name: "laptop" },
      }),
    );
    expect(
      (await ok("GET", `/api/runs/${run.id}`, { cookie: ada })).transcriptId,
    ).toBe(first.json.id);

    // The agent finishes: the Run's own token is revoked, but the Machine's last upload still lands.
    await ok("POST", `/api/runs/${run.id}/finish`, {
      token,
      body: { outcome: "ready" },
    });
    await cronk.jobsSettled();
    const last = await uploadTranscript(machineToken, run.id, jsonl(3));

    expect(last.status).toBe(200);
    expect(last.json).toEqual(
      expect.objectContaining({
        id: first.json.id,
        runId: run.id,
        entryCount: 3,
      }),
    );
  });

  test("is refused before the Run's session is reported, and for a Run the Machine doesn't hold", async () => {
    const { ada, runner, machineToken, delegate } = await localSetUp();
    const other = await pair(ada, [runner.id]);
    const { run } = await delegate("Too soon");
    await claim(machineToken, run.id);

    const early = await uploadTranscript(machineToken, run.id, jsonl(1));
    expect(early.status).toBe(409);
    expect(early.json.error.code).toBe("no_session");

    await ok("POST", `/api/machine/runs/${run.id}/session`, {
      token: machineToken,
      body: { sessionId: "4f1c2b9e" },
    });
    expect((await uploadTranscript(other, run.id, jsonl(1))).status).toBe(404);
  });

  test("stops being kept once a User deleted it", async () => {
    const { ada, machineToken, delegate } = await localSetUp();
    const { run } = await delegate("Secret");
    await claim(machineToken, run.id);
    await ok("POST", `/api/machine/runs/${run.id}/session`, {
      token: machineToken,
      body: { sessionId: "4f1c2b9e" },
    });
    const { json: transcript } = await uploadTranscript(
      machineToken,
      run.id,
      jsonl(1),
    );

    await ok("DELETE", `/api/transcripts/${transcript.id}`, { cookie: ada });
    const refused = await uploadTranscript(machineToken, run.id, jsonl(2));

    expect(refused.status).toBe(410);
    expect(refused.json.error.code).toBe("transcript_deleted");
  });
});

describe("a local Run's cost", () => {
  test("reported with its end is recorded as an estimate, on the Run, its Ticket's total and its Runner's month", async () => {
    const { ada, runner, machineToken, delegate } = await localSetUp();
    const { ticket, run } = await delegate("Costly");
    const { token } = (await claim(machineToken, run.id)).json;
    await ok("POST", `/api/runs/${run.id}/finish`, {
      token,
      body: { outcome: "ready" },
    });

    await ok("POST", `/api/machine/runs/${run.id}/end`, {
      token: machineToken,
      body: { reason: "claude exited with code 0", costUsd: 1.234 },
    });

    const estimate = { amount: 123, currency: "USD", estimate: true };
    expect(
      (await ok("GET", `/api/runs/${run.id}`, { cookie: ada })).cost,
    ).toEqual(estimate);
    expect(
      (await ok("GET", `/api/tickets/${ticket.id}`, { cookie: ada })).cost,
    ).toEqual([estimate]);
    const runners = await ok("GET", "/api/runners", { cookie: ada });
    expect(
      runners.find((r: { id: string }) => r.id === runner.id).costThisMonth,
    ).toEqual([estimate]);
  });

  test("of a Run that failed is recorded too, and an end without one records none", async () => {
    const { ada, machineToken, delegate } = await localSetUp({ runLimit: 2 });
    const { run: failed } = await delegate("Failed");
    const { run: silent } = await delegate("Silent");
    await claim(machineToken, failed.id);
    await claim(machineToken, silent.id);

    await ok("POST", `/api/machine/runs/${failed.id}/end`, {
      token: machineToken,
      body: { reason: "claude exited with code 1", costUsd: 0.5 },
    });
    await ok("POST", `/api/machine/runs/${silent.id}/end`, {
      token: machineToken,
      body: { reason: "claude was killed by SIGKILL" },
    });

    const failedRun = await ok("GET", `/api/runs/${failed.id}`, {
      cookie: ada,
    });
    expect(failedRun).toEqual(
      expect.objectContaining({
        state: "failed",
        cost: { amount: 50, currency: "USD", estimate: true },
      }),
    );
    expect(
      (await ok("GET", `/api/runs/${silent.id}`, { cookie: ada })).cost,
    ).toBeNull();
  });

  test("estimates stay apart from real costs in a Ticket's total", async () => {
    const { ada, machineToken, delegate } = await localSetUp();
    const { ticket, run } = await delegate("Mixed");
    await claim(machineToken, run.id);
    await ok("POST", `/api/machine/runs/${run.id}/end`, {
      token: machineToken,
      body: { reason: "claude exited with code 1", costUsd: 0.25 },
    });
    // A real cost on the same Ticket, as a Managed Agents session reports one.
    await cronk.stage(
      `insert into runs (id, workspace_id, ticket_id, agent_id, status_id, status_name, model, brief, state, started_at, ended_at, cost_amount, cost_currency)
       select gen_random_uuid(), workspace_id, ticket_id, agent_id, status_id, status_name, model, brief, 'failed', started_at, ended_at, 300, 'USD'
       from runs where id = $1`,
      [run.id],
    );

    expect(
      (await ok("GET", `/api/tickets/${ticket.id}`, { cookie: ada })).cost,
    ).toEqual([
      { amount: 300, currency: "USD", estimate: false },
      { amount: 25, currency: "USD", estimate: true },
    ]);
  });
});
