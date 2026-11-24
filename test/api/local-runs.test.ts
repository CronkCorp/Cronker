import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { minutes } from "../harness/clock.js";
import { setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";
import { openMachineStream, openRunnerStream, type OpenStream } from "../harness/stream.js";

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
    headers: { ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...options.headers },
  });
  return { status: response.status, json: response.status === 204 ? null : await response.json() };
}

async function ok(method: string, path: string, options: CallOptions = {}) {
  const response = await call(method, path, options);
  expect(response.status, `${method} ${path}: ${JSON.stringify(response.json)}`).toBeLessThan(300);
  return response.json;
}

async function pair(ada: string, runnerIds: string[], limit?: number, name = "ada-laptop") {
  const started = await ok("POST", "/api/machines/pairings", {
    body: { name, os: "linux", daemonVersion: "0.3.0", ...(limit ? { limit } : {}) },
  });
  await ok("POST", "/api/machines/pairings/approve", { cookie: ada, body: { userCode: started.userCode, runnerIds } });
  const paired = await ok("POST", "/api/machines/pairings/poll", { body: { deviceCode: started.deviceCode } });
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
async function localSetUp({ runLimit = 1, machineLimit, connected = true }: { runLimit?: number; machineLimit?: number; connected?: boolean } = {}) {
  const { workspace } = await setUp(cronk);
  const ada = await signIn(cronk);
  const runner = await ok("POST", "/api/runners", { cookie: ada, body: { name: "Laptop", kind: "local" } });
  if (runLimit !== 1) await ok("PATCH", `/api/runners/${runner.id}`, { cookie: ada, body: { limit: runLimit } });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, { cookie: ada, body: { name: "laptop" } });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, { cookie: ada, body: { runnerId: runner.id } });
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, { cookie: ada, body: { name: "Cronker", key: "CRONK" } });
  const triage = project.statuses.find((s: { name: string }) => s.name === "Triage").id as string;
  const machineToken = await pair(ada, [runner.id], machineLimit);
  if (connected) await connect(machineToken);
  /** Files a Ticket and delegates it into Triage, answering its Run, if it got one. */
  const delegate = async (title: string, { labels = [], priority }: { labels?: string[]; priority?: string } = {}) => {
    const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, { cookie: ada, body: { title, labels } });
    if (priority) await ok("PATCH", `/api/tickets/${ticket.id}`, { cookie: ada, body: { priority } });
    await ok("PATCH", `/api/tickets/${ticket.id}`, { cookie: ada, body: { delegateId: agent.id, statusId: triage } });
    const [run] = await ok("GET", `/api/tickets/${ticket.id}/runs`, { cookie: ada });
    return { ticket, run };
  };
  const runsOf = (ticketId: string) => ok("GET", `/api/tickets/${ticketId}/runs`, { cookie: ada });
  const runnerRecord = async () => (await ok("GET", "/api/runners", { cookie: ada })).find((r: { id: string }) => r.id === runner.id);
  return { workspace, ada, runner, agent, project, machineToken, delegate, runsOf, runnerRecord };
}

/** Waits until the check passes, as a stream's close reaches the server on its own time. */
async function eventually(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const claim = (token: string, runId: string) => call("POST", `/api/machine/runs/${runId}/claim`, { token });

describe("claiming a local Run", () => {
  test("a connected Machine hears of the Run as it starts and claims it with what claude needs", async () => {
    const { ada, machineToken, delegate } = await localSetUp();
    const stream = await connect(machineToken);

    const { run } = await delegate("Touch the laptop", { labels: ["local-only"] });

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
    });
  });

  test("a Machine connecting is told of the Runs already waiting to be claimed", async () => {
    const { machineToken, delegate } = await localSetUp();
    const { run } = await delegate("Waiting");

    const stream = await connect(machineToken);

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

  test("a Runner whose limit was lowered gets no more Runs claimed than it until one ends", async () => {
    const { ada, runner, machineToken, delegate } = await localSetUp({ runLimit: 2, machineLimit: 5 });
    const { run: first } = await delegate("One");
    const { run: second } = await delegate("Two");
    await ok("PATCH", `/api/runners/${runner.id}`, { cookie: ada, body: { limit: 1 } });

    expect((await claim(machineToken, first.id)).status).toBe(200);
    const refused = await claim(machineToken, second.id);
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe("runner_limit_reached");

    await ok("POST", `/api/machine/runs/${first.id}/end`, { token: machineToken, body: { reason: "claude exited with code 0" } });
    expect((await claim(machineToken, second.id)).status).toBe(200);
  });

  test("a Machine at its limit claims again once one of its Runs ends", async () => {
    const { machineToken, delegate } = await localSetUp({ runLimit: 2, machineLimit: 1 });
    const { run: first } = await delegate("One");
    const { run: second } = await delegate("Two");
    await claim(machineToken, first.id);
    expect((await claim(machineToken, second.id)).json.error.code).toBe("machine_limit_reached");

    await ok("POST", `/api/machine/runs/${first.id}/end`, { token: machineToken, body: { reason: "claude exited with code 0" } });

    expect((await claim(machineToken, second.id)).status).toBe(200);
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

describe("an offline local Runner", () => {
  test("keeps its delegated Tickets waiting, refusing none, and starts them in Priority order once a Machine connects", async () => {
    const { ada, machineToken, delegate, runsOf } = await localSetUp({ runLimit: 2, connected: false });
    const low = await delegate("Low", { priority: "low" });
    const urgent = await delegate("Urgent", { priority: "urgent" });
    const high = await delegate("High", { priority: "high" });

    for (const { ticket, run } of [low, urgent, high]) {
      expect(run).toBeUndefined();
      expect((await ok("GET", `/api/tickets/${ticket.id}`, { cookie: ada })).waiting).toBe("runnerOffline");
    }

    const stream = await connect(machineToken);

    const [urgentRun] = await runsOf(urgent.ticket.id);
    const [highRun] = await runsOf(high.ticket.id);
    expect(urgentRun.state).toBe("running");
    expect(highRun.state).toBe("running");
    expect(await runsOf(low.ticket.id)).toEqual([]);
    expect((await ok("GET", `/api/tickets/${low.ticket.id}`, { cookie: ada })).waiting).toBe("runnerSlot");
    expect(await stream.next()).toEqual({ type: "run.claimable", data: { runId: urgentRun.id } });
    expect(await stream.next()).toEqual({ type: "run.claimable", data: { runId: highRun.id } });
  });

  test("shows since when on its record, telling its Owner's stream as a Machine connects and goes", async () => {
    const { ada, runner, machineToken, runnerRecord } = await localSetUp({ connected: false });
    expect((await runnerRecord()).offlineSince).toBe(runner.createdAt);
    const runners = await openRunnerStream(cronk, ada);
    streams.push(runners);

    const machine = await connect(machineToken);

    expect(await runners.next()).toEqual({ type: "runner.changed", data: { runnerId: runner.id } });
    expect((await runnerRecord()).offlineSince).toBeNull();
    const [shown] = await ok("GET", "/api/machines", { cookie: ada });
    expect(shown.connected).toBe(true);

    cronk.clock.advance(minutes(5));
    machine.close();

    expect(await runners.next()).toEqual({ type: "runner.changed", data: { runnerId: runner.id } });
    expect((await runnerRecord()).offlineSince).toBe(cronk.clock.now().toISOString());
    const [gone] = await ok("GET", "/api/machines", { cookie: ada });
    expect(gone.connected).toBe(false);
  });

  test("stays online while another Machine serving it is connected", async () => {
    const { ada, runner, machineToken, runnerRecord } = await localSetUp({ connected: false });
    const desktop = await pair(ada, [runner.id], undefined, "ada-desktop");
    const laptop = await connect(machineToken);
    await connect(desktop);

    laptop.close();
    await eventually(async () => {
      const machines = await ok("GET", "/api/machines", { cookie: ada });
      return machines.find((m: { name: string }) => m.name === "ada-laptop").connected === false;
    });

    expect((await runnerRecord()).offlineSince).toBeNull();
  });

  test("leaves a Run told already claimable when its Machine goes", async () => {
    const { machineToken, delegate, runnerRecord } = await localSetUp({ connected: false });
    const machine = await connect(machineToken);
    const { run } = await delegate("Told");
    machine.close();
    await eventually(async () => (await runnerRecord()).offlineSince !== null);

    const back = await connect(machineToken);

    expect(await back.next()).toEqual({ type: "run.claimable", data: { runId: run.id } });
    expect((await claim(machineToken, run.id)).status).toBe(200);
  });
});

describe("the daemon's version and limit", () => {
  test("a daemon too old for Cronk can't pair, told the version to upgrade to", async () => {
    const refused = await call("POST", "/api/machines/pairings", { body: { name: "old-laptop", os: "linux", daemonVersion: "0.2.9" } });

    expect(refused.status).toBe(426);
    expect(refused.json.error.code).toBe("daemon_too_old");
    expect(refused.json.error.message).toContain("upgrade cronk-runner to 0.3.0");
  });

  test("a paired Machine whose daemon announces an old version is refused, and its card says what to upgrade to", async () => {
    const { ada, machineToken } = await localSetUp({ connected: false });
    const old = { "x-cronk-runner-version": "0.2.0" };

    for (const [method, path] of [["GET", "/api/machine"], ["GET", "/api/machine/events"]] as const) {
      const refused = await call(method, path, { token: machineToken, headers: old });
      expect(refused.status).toBe(426);
      expect(refused.json.error).toEqual({
        code: "daemon_too_old",
        message: "This Cronk works with cronk-runner 0.3.0 or later, and this Machine runs 0.2.0: upgrade cronk-runner to 0.3.0 or later, then start it again.",
      });
    }
    const [machine] = await ok("GET", "/api/machines", { cookie: ada });
    expect(machine).toEqual(expect.objectContaining({ daemonVersion: "0.2.0", upgradeTo: "0.3.0", connected: false }));

    await ok("GET", "/api/machine", { token: machineToken, headers: { "x-cronk-runner-version": "0.3.1" } });
    const [upgraded] = await ok("GET", "/api/machines", { cookie: ada });
    expect(upgraded).toEqual(expect.objectContaining({ daemonVersion: "0.3.1", upgradeTo: null }));
  });

  test("the limit a daemon announces replaces the one it paired with", async () => {
    const { ada, machineToken } = await localSetUp({ connected: false });

    await ok("GET", "/api/machine", { token: machineToken, headers: { "x-cronk-runner-limit": "4" } });

    const [machine] = await ok("GET", "/api/machines", { cookie: ada });
    expect(machine.limit).toBe(4);
  });
});
