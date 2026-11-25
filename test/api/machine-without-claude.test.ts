import { afterEach, beforeEach, expect, test } from "vitest";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";
import { openMachineStream, type OpenStream } from "../harness/stream.js";

/**
 * Seam 1: Machines without Claude (CRONK-162), with the test playing the daemons over Cronk's HTTP API. A Run on an
 * unmapped label needs Claude: it waits while only offline Machines of its Runner run it, and is refused, naming the
 * label, when none does.
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
    headers: options.token ? { authorization: `Bearer ${options.token}`, "x-cronk-runner-version": "0.6.0" } : {},
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

  const machine = async (
    name: string,
    models: (typeof qwen)[] | null,
    { limit = 2, claude = true }: { limit?: number; claude?: boolean } = {},
  ) => {
    const started = await ok("POST", "/api/machines/pairings", { body: { name, os: "linux", daemonVersion: "0.6.0", limit } });
    await ok("POST", "/api/machines/pairings/approve", { cookie: ada, body: { userCode: started.userCode, runnerIds: [runner.id] } });
    const paired = await ok("POST", "/api/machines/pairings/poll", { body: { deviceCode: started.deviceCode } });
    const token = paired.machineToken as string;
    const stream = await openMachineStream(cronk, token);
    streams.push(stream);
    // An older daemon announces nothing.
    if (models) await ok("PUT", "/api/machine/announcement", { token, body: { claude, models } });
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

test("a Machine that doesn't run Claude isn't told of a Run needing it and can't claim one; a Machine running Claude claims it", async () => {
  const { machine, delegate } = await adaWithRunner();
  const gpu = await machine("ada-gpu", [qwen], { claude: false });
  const laptop = await machine("ada-laptop", []);
  await drain(gpu.stream);
  await drain(laptop.stream);

  const { run } = await delegate("On Claude");

  expect(run.state).toBe("running");
  expect(await laptop.stream.next()).toEqual({ type: "run.claimable", data: { runId: run.id } });
  await gpu.stream.expectQuiet(300);
  const refused = await claim(gpu.token, run.id);
  expect(refused.status).toBe(409);
  expect(refused.json.error.code).toBe("machine_runs_no_claude");
  expect((await claim(laptop.token, run.id)).status).toBe(200);
});

test("with no Machine serving the Runner running Claude, a Run on an unmapped label is refused naming the label", async () => {
  const { machine, delegate } = await adaWithRunner();
  await machine("ada-gpu", [qwen], { claude: false });

  const { run } = await delegate("Nowhere to run Claude");

  expect(run.state).toBe("refused");
  expect(run.endReason).toContain("label haiku needs Claude");
  expect(run.endReason).toContain("Laptop");
});

test("a Run on an unmapped label waits while only an offline Machine runs Claude, and starts once it connects", async () => {
  const { machine, delegate, ticketOf, runsOf, offline } = await adaWithRunner();
  const laptop = await machine("ada-laptop", []);
  await machine("ada-gpu", [qwen], { claude: false });
  laptop.stream.close();
  await offline("ada-laptop");

  const { ticket, run } = await delegate("Later on Claude");

  expect(run).toBeUndefined();
  expect(await ticketOf(ticket.id)).toEqual(expect.objectContaining({ waiting: "claude", waitingModel: null }));
  streams.push(await openMachineStream(cronk, laptop.token));
  await eventually(async () => (await runsOf(ticket.id)).length === 1);
  expect((await ticketOf(ticket.id)).waiting).toBeNull();
});

test("a Ticket waiting for Claude starts once a connected Machine announces it runs Claude", async () => {
  const { machine, delegate, ticketOf, runsOf, offline } = await adaWithRunner();
  const laptop = await machine("ada-laptop", []);
  const gpu = await machine("ada-gpu", [qwen], { claude: false });
  laptop.stream.close();
  await offline("ada-laptop");
  const { ticket } = await delegate("Signed in later");
  expect((await ticketOf(ticket.id)).waiting).toBe("claude");

  await ok("PUT", "/api/machine/announcement", { token: gpu.token, body: { claude: true, models: [qwen] } });

  await eventually(async () => (await runsOf(ticket.id)).length === 1);
  const [started] = await runsOf(ticket.id);
  expect((await claim(gpu.token, started!.id)).status).toBe(200);
});

test("the queue passes by a Ticket waiting for Claude, holding no slot for it", async () => {
  const { ada, runner, machine, map, delegate, ticketOf, offline } = await adaWithRunner();
  await ok("PATCH", `/api/runners/${runner.id}`, { cookie: ada, body: { limit: 1 } });
  const laptop = await machine("ada-laptop", []);
  await machine("ada-gpu", [qwen], { claude: false });
  await map([{ label: "sonnet", model: "qwen" }]);
  laptop.stream.close();
  await offline("ada-laptop");

  const urgent = await delegate("Urgent on Claude", { priority: "urgent" });
  const onQwen = await delegate("Low on qwen", { priority: "low", status: "Investigate" });

  expect(urgent.run).toBeUndefined();
  expect((await ticketOf(urgent.ticket.id)).waiting).toBe("claude");
  expect(onQwen.run?.state).toBe("running");
});

test("the last Machine running Claude saying it no longer does fails the Runs not claimed yet that need it, naming the label", async () => {
  const { machine, delegate, run } = await adaWithRunner({ runLimit: 2 });
  const laptop = await machine("ada-laptop", []);
  const { run: claimed } = await delegate("Claimed");
  expect((await claim(laptop.token, claimed.id)).status).toBe(200);
  const { run: unclaimed } = await delegate("Not claimed yet");

  await ok("PUT", "/api/machine/announcement", { token: laptop.token, body: { claude: false, models: [] } });

  await eventually(async () => (await run(unclaimed.id)).state === "failed");
  expect((await run(unclaimed.id)).endReason).toContain("label haiku needs Claude");
  expect((await run(claimed.id)).state).toBe("running");
});

test("an older daemon, announcing nothing, counts as running Claude and claims a Run needing it", async () => {
  const { machine, delegate } = await adaWithRunner();
  const old = await machine("ada-old", null);

  const { run } = await delegate("On an old daemon");

  expect(run.state).toBe("running");
  expect((await claim(old.token, run.id)).status).toBe(200);
});
