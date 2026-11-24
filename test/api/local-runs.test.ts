import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { minutes } from "../harness/clock.js";
import { setUp, signIn } from "../harness/flows.js";
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
    });
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

describe("stopping a local Run", () => {
  const stopped = (machineToken: string, runId: string) => call("POST", `/api/machine/runs/${runId}/stopped`, { token: machineToken });

  test("a stop while the Machine is connected is told on its stream, and its confirmation is taken once or more", async () => {
    const { ada, machineToken, delegate } = await localSetUp();
    const stream = await openMachineStream(cronk, machineToken);
    streams.push(stream);
    const { ticket, run } = await delegate("Stop me");
    expect(await stream.next()).toEqual({ type: "run.claimable", data: { runId: run.id } });
    await claim(machineToken, run.id);

    await ok("PATCH", `/api/tickets/${ticket.id}`, { cookie: ada, body: { delegateId: null } });

    expect(await stream.next()).toEqual({ type: "run.stop", data: { runId: run.id } });
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

    await ok("PATCH", `/api/tickets/${ticket.id}`, { cookie: ada, body: { delegateId: null } });
    await cronk.jobsSettled();

    expect((await ok("GET", `/api/runs/${run.id}`, { cookie: ada })).state).toBe("stopped");
    expect((await call("GET", "/api/agent", { token })).status).toBe(401);
    for (let i = 0; i < 2; i++) {
      const stream = await openMachineStream(cronk, machineToken);
      streams.push(stream);
      expect(await stream.next()).toEqual({ type: "run.stop", data: { runId: run.id } });
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
    await ok("PATCH", `/api/tickets/${ticket.id}`, { cookie: ada, body: { delegateId: null } });

    await ok("POST", `/api/machine/runs/${run.id}/end`, { token: machineToken, body: { reason: "claude was killed by SIGTERM" } });

    const stream = await openMachineStream(cronk, machineToken);
    streams.push(stream);
    await stream.expectQuiet();
    expect((await ok("GET", `/api/runs/${run.id}`, { cookie: ada })).state).toBe("stopped");
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
    expect(ended.endReason).toBe("ada-laptop, the Machine running it, was unpaired.");
    expect((await call("GET", "/api/agent", { token })).status).toBe(401);
    // Its slot is free again.
    const [listed] = (await ok("GET", "/api/runners", { cookie: ada })).filter((r: { id: string }) => r.id === runner.id);
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

    expect(await stream.next()).toEqual({ type: "run.stop", data: { runId: run.id } });
    expect((await ok("GET", `/api/runs/${run.id}`, { cookie: ada })).state).toBe("stopped");
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
    expect((await ok("GET", `/api/runs/${run.id}`, { cookie: set.ada })).state).toBe("lost");
    return { ...set, ticket, run, token };
  }

  test("goes lost without heartbeats, keeping its token, and a later heartbeat brings it back", async () => {
    const { ada, machineToken, run, token } = await lostRun();
    expect((await call("GET", "/api/agent", { token })).status).toBe(200);
    // A lost Run isn't told to stop: it may yet come back.
    const stream = await openMachineStream(cronk, machineToken);
    streams.push(stream);
    await stream.expectQuiet();

    expect((await call("POST", `/api/machine/runs/${run.id}/heartbeat`, { token: machineToken })).status).toBe(204);

    const back = await ok("GET", `/api/runs/${run.id}`, { cookie: ada });
    expect(back.state).toBe("running");
    expect(back.endReason).toBeNull();
    const finished = await ok("POST", `/api/runs/${run.id}/finish`, { token, body: { outcome: "ready" } });
    expect(finished.state).toBe("finished");
  });

  test("whose Ticket moved on meanwhile is told to stop on waking, and its token is revoked", async () => {
    const { ada, machineToken, ticket, run, token } = await lostRun();
    await ok("PATCH", `/api/tickets/${ticket.id}`, { cookie: ada, body: { delegateId: null } });

    const beat = await call("POST", `/api/machine/runs/${run.id}/heartbeat`, { token: machineToken });

    expect(beat.status).toBe(409);
    expect(beat.json.error.code).toBe("run_stopped");
    expect((await ok("GET", `/api/runs/${run.id}`, { cookie: ada })).state).toBe("lost");
    expect((await call("GET", "/api/agent", { token })).status).toBe(401);
    // Told by the answer, it isn't told again on the stream.
    const stream = await openMachineStream(cronk, machineToken);
    streams.push(stream);
    await stream.expectQuiet();
  });
});
