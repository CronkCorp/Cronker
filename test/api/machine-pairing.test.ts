import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { minutes, seconds } from "../harness/clock.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

let cronk: StartedCronk;
beforeEach(async () => {
  cronk = await startCronk();
});
afterEach(async () => {
  await cronk?.stop();
});

async function call(method: string, path: string, options: { cookie?: string; body?: unknown; token?: string } = {}) {
  const response = await cronk.request(method, path, {
    cookie: options.cookie,
    body: options.body,
    headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
  });
  return { status: response.status, json: response.status === 204 ? null : await response.json() };
}

async function ok(method: string, path: string, options: { cookie?: string; body?: unknown; token?: string } = {}) {
  const response = await call(method, path, options);
  expect(response.status, `${method} ${path}: ${JSON.stringify(response.json)}`).toBeLessThan(300);
  return response.json;
}

const laptop = { name: "ada-laptop", os: "darwin", daemonVersion: "0.3.0" };

/** Ada, signed in, with a `local` Runner. */
async function adaWithLocalRunner() {
  const { workspace } = await setUp(cronk);
  const ada = await signIn(cronk);
  const runner = await ok("POST", "/api/runners", { cookie: ada, body: { name: "Laptop", kind: "local" } });
  return { workspace, ada, runner };
}

/** A daemon asks for a code, Ada approves it for the Runners, and the daemon polls for its token. */
async function pair(ada: string, runnerIds: string[]) {
  const started = await ok("POST", "/api/machines/pairings", { body: laptop });
  const machine = await ok("POST", "/api/machines/pairings/approve", { cookie: ada, body: { userCode: started.userCode, runnerIds } });
  const paired = await ok("POST", "/api/machines/pairings/poll", { body: { deviceCode: started.deviceCode } });
  return { machine, token: paired.machineToken as string };
}

describe("a local Runner", () => {
  test("can be set up, isn't cloud, and takes a local-only Ticket's Delegation and its Run", async () => {
    const { workspace, ada, runner } = await adaWithLocalRunner();
    expect(runner).toEqual(expect.objectContaining({ kind: "local", cloud: false }));

    const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, { cookie: ada, body: { name: "Cronker", key: "CRONK" } });
    const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, { cookie: ada, body: { title: "Touch the laptop", labels: ["local-only"] } });
    const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, { cookie: ada, body: { name: "laptop" } });
    const agent = await ok("PATCH", `/api/agents/${created.id}`, { cookie: ada, body: { runnerId: runner.id } });
    expect(agent.cloud).toBe(false);
    const triage = project.statuses.find((s: { name: string }) => s.name === "Triage").id;

    await ok("PATCH", `/api/tickets/${ticket.id}`, { cookie: ada, body: { delegateId: agent.id, statusId: triage } });

    const [run] = await ok("GET", `/api/tickets/${ticket.id}/runs`, { cookie: ada });
    expect(run.state).toBe("running");
  });
});

describe("pairing a Machine", () => {
  test("the daemon gets a short code and a link, waits for approval, then receives its token once", async () => {
    const { ada, runner } = await adaWithLocalRunner();

    const started = await ok("POST", "/api/machines/pairings", { body: laptop });
    expect(started).toEqual({
      deviceCode: expect.stringMatching(/^cronk_device_code_/),
      userCode: expect.stringMatching(/^[A-Z]{4}-[A-Z]{4}$/),
      verificationUrl: `${cronk.url}/runners`,
      expiresAt: new Date(cronk.clock.now().getTime() + minutes(10)).toISOString(),
      interval: 2,
    });

    const pending = await call("POST", "/api/machines/pairings/poll", { body: { deviceCode: started.deviceCode } });
    expect(pending.status).toBe(409);
    expect(pending.json.error.code).toBe("pairing_pending");

    // Typed in lowercase without the dash, it still matches.
    const userCode = started.userCode.replace("-", "").toLowerCase();
    const machine = await ok("POST", "/api/machines/pairings/approve", { cookie: ada, body: { userCode, runnerIds: [runner.id] } });
    expect(machine).toEqual(
      expect.objectContaining({ name: "ada-laptop", os: "darwin", daemonVersion: "0.3.0", limit: 2, lastContactAt: null, runners: [{ id: runner.id, name: "Laptop" }] }),
    );

    const paired = await ok("POST", "/api/machines/pairings/poll", { body: { deviceCode: started.deviceCode } });
    expect(paired).toEqual({ machineToken: expect.stringMatching(/^cronk_machine_/), machine: { id: machine.id, name: "ada-laptop" } });

    const again = await call("POST", "/api/machines/pairings/poll", { body: { deviceCode: started.deviceCode } });
    expect(again.status).toBe(410);
    expect(again.json.error.code).toBe("pairing_expired");

    const self = await ok("GET", "/api/machine", { token: paired.machineToken });
    expect(self).toEqual({ id: machine.id, name: "ada-laptop", owner: expect.objectContaining({ email: "ada@example.com" }), runners: [{ id: runner.id, name: "Laptop" }] });

    const [listed] = await ok("GET", "/api/machines", { cookie: ada });
    expect(listed).toEqual(expect.objectContaining({ id: machine.id, lastContactAt: cronk.clock.now().toISOString() }));
    expect(JSON.stringify(listed)).not.toContain(paired.machineToken);
  });

  test("a code expires after ten minutes, for approving and for polling", async () => {
    const { ada, runner } = await adaWithLocalRunner();
    const started = await ok("POST", "/api/machines/pairings", { body: laptop });

    cronk.clock.advance(minutes(10));

    const approving = await call("POST", "/api/machines/pairings/approve", { cookie: ada, body: { userCode: started.userCode, runnerIds: [runner.id] } });
    expect(approving.status).toBe(404);
    expect(approving.json.error.code).toBe("pairing_not_found");
    const polling = await call("POST", "/api/machines/pairings/poll", { body: { deviceCode: started.deviceCode } });
    expect(polling.status).toBe(410);

    // Approved just in time, it must be redeemed in time too.
    const late = await ok("POST", "/api/machines/pairings", { body: laptop });
    cronk.clock.advance(minutes(10) - seconds(1));
    await ok("POST", "/api/machines/pairings/approve", { cookie: ada, body: { userCode: late.userCode, runnerIds: [runner.id] } });
    cronk.clock.advance(seconds(1));
    expect((await call("POST", "/api/machines/pairings/poll", { body: { deviceCode: late.deviceCode } })).status).toBe(410);
  });

  test("a code is approved only once", async () => {
    const { ada, runner } = await adaWithLocalRunner();
    const started = await ok("POST", "/api/machines/pairings", { body: laptop });
    await ok("POST", "/api/machines/pairings/approve", { cookie: ada, body: { userCode: started.userCode, runnerIds: [runner.id] } });

    const twice = await call("POST", "/api/machines/pairings/approve", { cookie: ada, body: { userCode: started.userCode, runnerIds: [runner.id] } });

    expect(twice.status).toBe(404);
    expect(twice.json.error.code).toBe("pairing_not_found");
    expect(await ok("GET", "/api/machines", { cookie: ada })).toHaveLength(1);
  });

  test("approval refuses another User's Runners and Runners of other kinds, pairing nothing", async () => {
    const { workspace, ada, runner } = await adaWithLocalRunner();
    const bob = await addMember(cronk, ada, workspace.id, "bob@example.com");
    const bobs = await ok("POST", "/api/runners", { cookie: bob.cookie, body: { name: "Bob's laptop", kind: "local" } });
    const subscription = await ok("POST", "/api/runners", { cookie: ada, body: { name: "Max", kind: "subscription" } });
    const started = await ok("POST", "/api/machines/pairings", { body: laptop });

    const others = await call("POST", "/api/machines/pairings/approve", { cookie: ada, body: { userCode: started.userCode, runnerIds: [runner.id, bobs.id] } });
    expect(others.status).toBe(404);
    expect(others.json.error).toEqual({ code: "not_found", message: "You have no such Runner." });

    const cloud = await call("POST", "/api/machines/pairings/approve", { cookie: ada, body: { userCode: started.userCode, runnerIds: [subscription.id] } });
    expect(cloud.status).toBe(409);
    expect(cloud.json.error).toEqual({
      code: "runner_not_local",
      message: "Max is a Runner of the kind subscription: a Machine serves only Runners of the kind local.",
    });

    expect(await ok("GET", "/api/machines", { cookie: ada })).toEqual([]);
    // Bob can't approve Ada's code onto her Runner either, but may approve it onto his own.
    expect((await call("POST", "/api/machines/pairings/approve", { cookie: bob.cookie, body: { userCode: started.userCode, runnerIds: [runner.id] } })).status).toBe(404);
    const bobsMachine = await ok("POST", "/api/machines/pairings/approve", { cookie: bob.cookie, body: { userCode: started.userCode, runnerIds: [bobs.id] } });
    expect(bobsMachine.runners).toEqual([{ id: bobs.id, name: "Bob's laptop" }]);
    expect(await ok("GET", "/api/machines", { cookie: ada })).toEqual([]);
  });

  test("only a signed-in User approves a code; an Agent's token is refused", async () => {
    const { workspace, ada, runner } = await adaWithLocalRunner();
    const agent = await ok("POST", `/api/workspaces/${workspace.id}/agents`, { cookie: ada, body: { name: "laptop" } });
    const { secret: token } = await ok("POST", `/api/agents/${agent.id}/tokens`, { cookie: ada, body: { name: "t", access: "write" } });
    const started = await ok("POST", "/api/machines/pairings", { body: laptop });

    expect((await call("POST", "/api/machines/pairings/approve", { body: { userCode: started.userCode, runnerIds: [runner.id] } })).status).toBe(401);
    const byAgent = await call("POST", "/api/machines/pairings/approve", { token, body: { userCode: started.userCode, runnerIds: [runner.id] } });
    expect(byAgent.status).toBe(403);
    expect(byAgent.json.error.code).toBe("agent_not_allowed");
  });
});

describe("unpairing a Machine", () => {
  test("revokes its token, so the daemon's later calls are refused, and drops it from the list", async () => {
    const { ada, runner } = await adaWithLocalRunner();
    const { machine, token } = await pair(ada, [runner.id]);
    await ok("GET", "/api/machine", { token });

    await ok("DELETE", `/api/machines/${machine.id}`, { cookie: ada });

    const refused = await call("GET", "/api/machine", { token });
    expect(refused.status).toBe(401);
    expect(refused.json.error.code).toBe("invalid_machine_token");
    expect(await ok("GET", "/api/machines", { cookie: ada })).toEqual([]);
    expect((await call("DELETE", `/api/machines/${machine.id}`, { cookie: ada })).status).toBe(404);
  });

  test("another User can't unpair someone else's Machine", async () => {
    const { workspace, ada, runner } = await adaWithLocalRunner();
    const bob = await addMember(cronk, ada, workspace.id, "bob@example.com");
    const { machine, token } = await pair(ada, [runner.id]);

    expect((await call("DELETE", `/api/machines/${machine.id}`, { cookie: bob.cookie })).status).toBe(404);
    await ok("GET", "/api/machine", { token });
  });

  test("an approved pairing unpaired before its poll gives no token", async () => {
    const { ada, runner } = await adaWithLocalRunner();
    const started = await ok("POST", "/api/machines/pairings", { body: laptop });
    const machine = await ok("POST", "/api/machines/pairings/approve", { cookie: ada, body: { userCode: started.userCode, runnerIds: [runner.id] } });
    await ok("DELETE", `/api/machines/${machine.id}`, { cookie: ada });

    expect((await call("POST", "/api/machines/pairings/poll", { body: { deviceCode: started.deviceCode } })).status).toBe(410);
  });

  test("removing a Runner stops a Machine serving it", async () => {
    const { ada, runner } = await adaWithLocalRunner();
    const { token } = await pair(ada, [runner.id]);

    await ok("DELETE", `/api/runners/${runner.id}`, { cookie: ada });

    expect((await ok("GET", "/api/machine", { token })).runners).toEqual([]);
  });
});
