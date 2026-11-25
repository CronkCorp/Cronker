import { afterEach, beforeEach, expect, test } from "vitest";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";
import { openMachineStream, type OpenStream } from "../harness/stream.js";

/**
 * Seam 1: a `local` Runner's Owner maps model labels to Machine models (CRONK-156), with the test playing the daemons
 * over Cronk's HTTP API.
 */

let cronk: StartedCronk;
let streams: OpenStream[];
beforeEach(async () => {
  cronk = await startCronk();
  streams = [];
});
afterEach(async () => {
  for (const stream of streams) stream.close();
  await cronk?.stop();
});

type Options = { cookie?: string; body?: unknown; token?: string };

async function call(method: string, path: string, options: Options = {}) {
  const response = await cronk.request(method, path, {
    cookie: options.cookie,
    body: options.body,
    headers: options.token ? { authorization: `Bearer ${options.token}`, "x-cronk-runner-version": "0.3.0" } : {},
  });
  return { status: response.status, json: response.status === 204 ? null : await response.json() };
}

async function ok(method: string, path: string, options: Options = {}) {
  const response = await call(method, path, options);
  expect(response.status, `${method} ${path}: ${JSON.stringify(response.json)}`).toBeLessThan(300);
  return response.json;
}

async function eventually(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const qwen = { name: "qwen", limit: 1, up: true };

/**
 * Ada with a `local` Runner, an Agent on it and a Project; `machine` pairs a Machine serving the Runner, connects it
 * and announces what it offers, as its daemon does.
 */
async function adaWithRunner({ runLimit = 1 }: { runLimit?: number } = {}) {
  const { workspace } = await setUp(cronk);
  const ada = await signIn(cronk);
  const runner = await ok("POST", "/api/runners", { cookie: ada, body: { name: "Laptop", kind: "local" } });
  if (runLimit !== 1) await ok("PATCH", `/api/runners/${runner.id}`, { cookie: ada, body: { limit: runLimit } });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, { cookie: ada, body: { name: "laptop" } });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, { cookie: ada, body: { runnerId: runner.id } });
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, { cookie: ada, body: { name: "Cronker", key: "CRONK" } });
  const statusId = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id as string;
  const triage = statusId("Triage");

  const machine = async (name: string, models: (typeof qwen)[] | null, { limit = 2 }: { limit?: number } = {}) => {
    const started = await ok("POST", "/api/machines/pairings", { body: { name, os: "linux", daemonVersion: "0.3.0", limit } });
    await ok("POST", "/api/machines/pairings/approve", { cookie: ada, body: { userCode: started.userCode, runnerIds: [runner.id] } });
    const paired = await ok("POST", "/api/machines/pairings/poll", { body: { deviceCode: started.deviceCode } });
    const token = paired.machineToken as string;
    const stream = await openMachineStream(cronk, token);
    streams.push(stream);
    // An older daemon announces nothing.
    if (models) await ok("PUT", "/api/machine/announcement", { token, body: { claude: true, models } });
    return { token, stream, id: paired.machine.id as string };
  };
  const map = (machineModels: { label: string; model: string }[]) =>
    ok("PATCH", `/api/runners/${runner.id}`, { cookie: ada, body: { machineModels } });
  // Triage's Step is on haiku, Investigate's on sonnet.
  const delegate = async (title: string, { priority, status = "Triage" }: { priority?: string; status?: string } = {}) => {
    const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, { cookie: ada, body: { title } });
    const statusOf = status === "Triage" ? triage : statusId(status);
    await ok("PATCH", `/api/tickets/${ticket.id}`, { cookie: ada, body: { delegateId: agent.id, statusId: statusOf, ...(priority ? { priority } : {}) } });
    const [run] = await ok("GET", `/api/tickets/${ticket.id}/runs`, { cookie: ada });
    return { ticket, run };
  };
  const run = (runId: string) => ok("GET", `/api/runs/${runId}`, { cookie: ada });
  /** Waits until Cronk has seen the named Machine's stream close. */
  const offline = (name: string) =>
    eventually(async () => {
      const machines = (await ok("GET", "/api/machines", { cookie: ada })) as { name: string; connected: boolean }[];
      return machines.find((m) => m.name === name)?.connected === false;
    });
  const ticketOf = (ticketId: string) => ok("GET", `/api/tickets/${ticketId}`, { cookie: ada });
  const runsOf = async (ticketId: string) => (await ok("GET", `/api/tickets/${ticketId}/runs`, { cookie: ada })) as { id: string; state: string }[];
  return { workspace, ada, runner, agent, machine, map, delegate, run, ticketOf, runsOf, offline };
}

const claim = (token: string, runId: string) => call("POST", `/api/machine/runs/${runId}/claim`, { token });

/** Skips what a stream announced before, so the next event is a new one. */
async function drain(stream: OpenStream) {
  for (;;) {
    try {
      await stream.next(150);
    } catch {
      return;
    }
  }
}

test("the Owner maps labels to Machine models their Machines offer, each label once ignoring case; none by default", async () => {
  const { ada, runner, workspace, machine, map } = await adaWithRunner();
  expect(runner.machineModels).toEqual([]);
  await machine("ada-gpu", [qwen, { name: "gpt-oss", limit: 1, up: false }]);

  const saved = await map([
    { label: " haiku ", model: "qwen" },
    { label: "Sonnet", model: "gpt-oss" },
  ]);
  expect(saved.machineModels).toEqual([
    { label: "haiku", model: "qwen" },
    { label: "Sonnet", model: "gpt-oss" },
  ]);
  expect((await ok("GET", "/api/runners", { cookie: ada }))[0].machineModels).toEqual(saved.machineModels);

  const twice = await call("PATCH", `/api/runners/${runner.id}`, {
    cookie: ada,
    body: { machineModels: [{ label: "haiku", model: "qwen" }, { label: "HAIKU", model: "gpt-oss" }] },
  });
  expect(twice.status).toBe(400);
  expect(twice.json.error.code).toBe("duplicate_model_label");

  const unknown = await call("PATCH", `/api/runners/${runner.id}`, { cookie: ada, body: { machineModels: [{ label: "opus", model: "llama" }] } });
  expect(unknown.status).toBe(400);
  expect(unknown.json.error.code).toBe("unknown_machine_model");
  expect(unknown.json.error.message).toContain("llama");

  // Only its Owner changes it: another User's Runner answers as not found.
  const { cookie: bob } = await addMember(cronk, ada, workspace.id, "bob@example.com");
  expect((await call("PATCH", `/api/runners/${runner.id}`, { cookie: bob, body: { machineModels: [] } })).status).toBe(404);

  // Other kinds of Runner have none.
  const max = await ok("POST", "/api/runners", { cookie: ada, body: { name: "Max", kind: "subscription" } });
  expect(max.machineModels).toBeNull();
  const refused = await call("PATCH", `/api/runners/${max.id}`, { cookie: ada, body: { machineModels: [] } });
  expect(refused.status).toBe(409);
  expect(refused.json.error.code).toBe("runner_has_no_machine_models");

  expect((await map([])).machineModels).toEqual([]);
});

test("a mapped label needs no model id, is announced only to Machines offering it, and is claimed with its Machine model", async () => {
  const { ada, workspace, machine, map, delegate, run } = await adaWithRunner();
  const gpu = await machine("ada-gpu", [qwen]);
  // An older daemon, announcing nothing, runs Claude only.
  const old = await machine("ada-old", null);
  await map([{ label: "HAIKU", model: "qwen" }]);
  await ok("DELETE", `/api/workspaces/${workspace.id}/model-ids/haiku`, { cookie: ada });
  await drain(gpu.stream);
  await drain(old.stream);

  const { run: started } = await delegate("On qwen");

  expect(started.state).toBe("running");
  expect(started.machineModel).toBeNull();
  expect(await gpu.stream.next()).toEqual({ type: "run.claimable", data: { runId: started.id } });
  await old.stream.expectQuiet(300);

  const refused = await claim(old.token, started.id);
  expect(refused.status).toBe(409);
  expect(refused.json.error.code).toBe("machine_model_missing");

  const claimed = await claim(gpu.token, started.id);
  expect(claimed.status).toBe(200);
  expect(claimed.json.machineModel).toBe("qwen");
  expect(claimed.json).not.toHaveProperty("modelId");
  expect(await run(started.id)).toEqual(expect.objectContaining({ model: "haiku", machineModel: "qwen", state: "running" }));
});

test("an unmapped label behaves as before: any Machine claims it with the Workspace's model id", async () => {
  const { machine, map, delegate, run } = await adaWithRunner();
  const gpu = await machine("ada-gpu", [qwen]);
  await map([{ label: "opus", model: "qwen" }]);

  const { run: started } = await delegate("On Claude");

  const claimed = await claim(gpu.token, started.id);
  expect(claimed.status).toBe(200);
  expect(claimed.json.modelId).toBe("claude-haiku-5-5");
  expect(claimed.json).not.toHaveProperty("machineModel");
  expect((await run(started.id)).machineModel).toBeNull();
});

test("with no Machine serving the Runner having the Machine model set up, the Run is refused naming the label, never falling back", async () => {
  const { machine, map, delegate } = await adaWithRunner();
  const gpu = await machine("ada-gpu", [qwen]);
  await map([{ label: "haiku", model: "qwen" }]);
  await ok("PUT", "/api/machine/announcement", { token: gpu.token, body: { claude: true, models: [] } });

  const { run } = await delegate("Nowhere to run");

  expect(run.state).toBe("refused");
  expect(run.endReason).toContain("label haiku");
  expect(run.endReason).toContain("qwen");
});

test("a Machine model set up only on an offline Machine keeps the Ticket waiting for it, until that Machine connects", async () => {
  const { machine, map, delegate, ticketOf, runsOf, offline } = await adaWithRunner();
  const gpu = await machine("ada-gpu", [qwen]);
  await map([{ label: "haiku", model: "qwen" }]);
  await machine("ada-laptop", [], {});
  gpu.stream.close();
  await offline("ada-gpu");

  const { ticket, run } = await delegate("Later");

  expect(run).toBeUndefined();
  expect(await ticketOf(ticket.id)).toEqual(expect.objectContaining({ waiting: "machineModel", waitingModel: "qwen" }));
  streams.push(await openMachineStream(cronk, gpu.token));
  await eventually(async () => (await runsOf(ticket.id)).length === 1);
  expect((await ticketOf(ticket.id)).waiting).toBeNull();
});

test("a Run that becomes refusable before its claim fails with the same reason", async () => {
  const { ada, machine, map, delegate, run } = await adaWithRunner({ runLimit: 2 });
  const gpu = await machine("ada-gpu", [qwen]);
  await map([{ label: "haiku", model: "qwen" }]);
  const { run: first } = await delegate("Lost its model");

  // The daemon stops offering it.
  await ok("PUT", "/api/machine/announcement", { token: gpu.token, body: { claude: true, models: [] } });
  await eventually(async () => (await run(first.id)).state === "failed");
  expect((await run(first.id)).endReason).toContain("label haiku");

  // Unpairing the only Machine with it fails the Runs needing it too.
  await ok("PUT", "/api/machine/announcement", { token: gpu.token, body: { claude: true, models: [qwen] } });
  const { run: second } = await delegate("Machine unpaired");
  expect(second.state).toBe("running");
  await ok("DELETE", `/api/machines/${gpu.id}`, { cookie: ada });
  await eventually(async () => (await run(second.id)).state === "failed");
  expect((await run(second.id)).endReason).toContain("qwen");
});

test("the mapping is read at the claim: a change applies to Runs not claimed yet and leaves claimed ones alone", async () => {
  const { machine, map, delegate, run } = await adaWithRunner({ runLimit: 3 });
  const gpu = await machine("ada-gpu", [{ ...qwen, limit: 2 }]);
  const claude = await machine("ada-laptop", []);

  // Started on Claude, then mapped before its claim: only a Machine with the Machine model claims it.
  const { run: remapped } = await delegate("Remapped");
  await drain(gpu.stream);
  await map([{ label: "haiku", model: "qwen" }]);
  expect(await gpu.stream.next()).toEqual({ type: "run.claimable", data: { runId: remapped.id } });
  expect((await claim(claude.token, remapped.id)).json.error.code).toBe("machine_model_missing");
  expect((await claim(gpu.token, remapped.id)).json.machineModel).toBe("qwen");

  // Mapped when it started, unmapped before its claim: it runs on Claude.
  const { run: unmapped } = await delegate("Unmapped");
  await map([]);
  const claimed = await claim(claude.token, unmapped.id);
  expect(claimed.status).toBe(200);
  expect(claimed.json.modelId).toBe("claude-haiku-5-5");

  // A claimed Run keeps the Machine model it was claimed on.
  expect((await run(remapped.id)).machineModel).toBe("qwen");
});

test("two Machines offering the Machine model race for a Run, and a Machine claims no more on it than its limit there", async () => {
  const { machine, map, delegate } = await adaWithRunner({ runLimit: 3 });
  const one = await machine("ada-gpu", [qwen], { limit: 5 });
  const two = await machine("ada-gpu-2", [{ ...qwen, limit: 2 }], { limit: 5 });
  await map([{ label: "haiku", model: "qwen" }]);
  const { run: first } = await delegate("First");
  const { run: second } = await delegate("Second");

  const raced = await Promise.all([claim(one.token, first.id), claim(two.token, first.id)]);
  expect(raced.map((c) => c.status).sort()).toEqual([200, 409]);
  expect(raced.find((c) => c.status === 409)!.json.error.code).toBe("run_not_claimable");

  // Whichever won, `one` has room for a single Run on qwen.
  const winner = raced[0]!.status === 200 ? one : two;
  if (winner === one) {
    const full = await claim(one.token, second.id);
    expect(full.status).toBe(409);
    expect(full.json.error.code).toBe("machine_model_limit_reached");
    expect((await claim(two.token, second.id)).status).toBe(200);
  } else {
    expect((await claim(one.token, second.id)).status).toBe(200);
    const { run: third } = await delegate("Third");
    const full = await claim(one.token, third.id);
    expect(full.json.error.code).toBe("machine_model_limit_reached");
  }
});

test("a Run's Machine model shows in the Agent Record and stays after the mapping changes", async () => {
  const { ada, agent, machine, map, delegate, run } = await adaWithRunner();
  const gpu = await machine("ada-gpu", [qwen]);
  await map([{ label: "haiku", model: "qwen" }]);
  const { run: started } = await delegate("Recorded");
  await claim(gpu.token, started.id);

  await map([]);
  await ok("POST", `/api/machine/runs/${started.id}/end`, { token: gpu.token, body: { reason: "this version can't run Machine models" } });

  expect(await run(started.id)).toEqual(expect.objectContaining({ machineModel: "qwen", state: "failed" }));
  const record = await ok("GET", `/api/agents/${agent.id}/record`, { cookie: ada });
  expect(record.entries.find((e: { kind: string }) => e.kind === "run")).toEqual(
    expect.objectContaining({ model: "haiku", machineModel: "qwen" }),
  );
});

test("a Ticket whose Machine model is down waits naming it, and starts once the model comes back", async () => {
  const { machine, map, delegate, ticketOf, runsOf } = await adaWithRunner();
  const gpu = await machine("ada-gpu", [{ ...qwen, up: false }]);
  await map([{ label: "haiku", model: "qwen" }]);

  const { ticket, run } = await delegate("Down");

  expect(run).toBeUndefined();
  expect(await ticketOf(ticket.id)).toEqual(expect.objectContaining({ waiting: "machineModel", waitingModel: "qwen" }));
  await drain(gpu.stream);
  await ok("PUT", "/api/machine/announcement", { token: gpu.token, body: { claude: true, models: [qwen] } });
  await eventually(async () => (await runsOf(ticket.id)).length === 1);
  const [started] = await runsOf(ticket.id);
  expect(started!.state).toBe("running");
  expect(await ticketOf(ticket.id)).toEqual(expect.objectContaining({ waiting: null, waitingModel: null }));
  expect((await claim(gpu.token, started!.id)).json.machineModel).toBe("qwen");
});

test("with every Machine offline, a Ticket on a Machine model waits for the Runner, not the model", async () => {
  const { machine, map, delegate, ticketOf, offline } = await adaWithRunner();
  const gpu = await machine("ada-gpu", [qwen]);
  await map([{ label: "haiku", model: "qwen" }]);
  gpu.stream.close();
  await offline("ada-gpu");

  const { ticket } = await delegate("Offline");

  await eventually(async () => (await ticketOf(ticket.id)).waiting === "runnerOffline");
  expect((await ticketOf(ticket.id)).waitingModel).toBeNull();
});

test("the queue passes by a Ticket waiting for its Machine model, holding no slot for it, and keeps Priority order among the rest", async () => {
  const { ada, runner, machine, map, delegate, ticketOf, runsOf } = await adaWithRunner();
  await ok("PATCH", `/api/runners/${runner.id}`, { cookie: ada, body: { limit: 1 } });
  const gpu = await machine("ada-gpu", [{ ...qwen, up: false }]);
  await map([{ label: "haiku", model: "qwen" }]);

  const urgent = await delegate("Urgent on qwen", { priority: "urgent" });
  const first = await delegate("First on Claude", { priority: "low", status: "Investigate" });
  const low = await delegate("Low on Claude", { priority: "low", status: "Investigate" });
  const high = await delegate("High on Claude", { priority: "high", status: "Investigate" });

  // The Runner's one slot goes to the first Ticket that can start, not to the urgent one waiting for qwen.
  expect(urgent.run).toBeUndefined();
  expect(first.run?.state).toBe("running");
  expect((await ticketOf(urgent.ticket.id)).waiting).toBe("machineModel");
  expect((await ticketOf(low.ticket.id)).waiting).toBe("runnerSlot");
  expect((await ticketOf(high.ticket.id)).waiting).toBe("runnerSlot");

  // A Run's end gives its slot to the highest Priority Ticket that can start.
  expect((await claim(gpu.token, first.run.id)).status).toBe(200);
  await ok("POST", `/api/machine/runs/${first.run.id}/end`, { token: gpu.token, body: { reason: "done" } });
  await eventually(async () => (await runsOf(high.ticket.id)).length === 1);
  expect(await runsOf(low.ticket.id)).toEqual([]);
  expect(await runsOf(urgent.ticket.id)).toEqual([]);
});

test("room for a Machine model is the sum of its connected Machines' limits; a Run's end starts the Ticket waiting for it", async () => {
  const { machine, map, delegate, ticketOf, runsOf } = await adaWithRunner({ runLimit: 5 });
  const one = await machine("ada-gpu", [qwen]);
  await machine("ada-gpu-2", [qwen]);
  await map([{ label: "haiku", model: "qwen" }]);

  const first = await delegate("First");
  const second = await delegate("Second");
  const third = await delegate("Third");

  expect(first.run?.state).toBe("running");
  expect(second.run?.state).toBe("running");
  expect(third.run).toBeUndefined();
  expect(await ticketOf(third.ticket.id)).toEqual(expect.objectContaining({ waiting: "machineModel", waitingModel: "qwen" }));

  expect((await claim(one.token, first.run.id)).status).toBe(200);
  await ok("POST", `/api/machine/runs/${first.run.id}/end`, { token: one.token, body: { reason: "done" } });
  await eventually(async () => (await runsOf(third.ticket.id)).length === 1);
});

test("a changed mapping starts the Tickets waiting for a Machine model", async () => {
  const { machine, map, delegate, runsOf } = await adaWithRunner();
  await machine("ada-gpu", [{ ...qwen, up: false }]);
  await map([{ label: "haiku", model: "qwen" }]);
  const { ticket, run } = await delegate("Remapped");
  expect(run).toBeUndefined();

  await map([]);

  await eventually(async () => (await runsOf(ticket.id)).length === 1);
});

test("a claimed Run isn't touched when its Machine model goes down", async () => {
  const { machine, map, delegate, run } = await adaWithRunner();
  const gpu = await machine("ada-gpu", [qwen]);
  await map([{ label: "haiku", model: "qwen" }]);
  const { run: started } = await delegate("Claimed");
  expect((await claim(gpu.token, started.id)).status).toBe(200);
  await drain(gpu.stream);

  await ok("PUT", "/api/machine/announcement", { token: gpu.token, body: { claude: true, models: [{ ...qwen, up: false }] } });

  await gpu.stream.expectQuiet(300);
  expect(await run(started.id)).toEqual(expect.objectContaining({ state: "running", machineModel: "qwen" }));
  expect((await call("POST", `/api/machine/runs/${started.id}/heartbeat`, { token: gpu.token })).status).toBeLessThan(300);
});
