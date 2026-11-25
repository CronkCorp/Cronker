import { afterEach, beforeEach, expect, test } from "vitest";
import { setUp, signIn, addMember } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";
import { openMachineStream, openRunnerStream, type OpenStream } from "../harness/stream.js";

/**
 * Seam 1: what a Machine announces it offers (CRONK-154), with the test playing the daemon over Cronk's HTTP API.
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

async function call(method: string, path: string, options: { cookie?: string; body?: unknown; token?: string } = {}) {
  const response = await cronk.request(method, path, {
    cookie: options.cookie,
    body: options.body,
    headers: options.token ? { authorization: `Bearer ${options.token}`, "x-cronk-runner-version": "0.3.0" } : {},
  });
  return { status: response.status, json: response.status === 204 ? null : await response.json() };
}

async function ok(method: string, path: string, options: { cookie?: string; body?: unknown; token?: string } = {}) {
  const response = await call(method, path, options);
  expect(response.status, `${method} ${path}: ${JSON.stringify(response.json)}`).toBeLessThan(300);
  return response.json;
}

/** Waits until the check passes, as a stream's close is recorded on its own time. */
async function eventually<T>(check: () => Promise<T | undefined | false>, timeoutMs = 5_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Ada, signed in, with a `local` Runner and a Machine paired to serve it. */
async function adaWithMachine() {
  const { workspace } = await setUp(cronk);
  const ada = await signIn(cronk);
  const runner = await ok("POST", "/api/runners", { cookie: ada, body: { name: "Laptop", kind: "local" } });
  const started = await ok("POST", "/api/machines/pairings", { body: { name: "ada-laptop", os: "linux", daemonVersion: "0.3.0" } });
  const machine = await ok("POST", "/api/machines/pairings/approve", { cookie: ada, body: { userCode: started.userCode, runnerIds: [runner.id] } });
  const paired = await ok("POST", "/api/machines/pairings/poll", { body: { deviceCode: started.deviceCode } });
  return { workspace, ada, runner, machine, token: paired.machineToken as string };
}

async function connect(token: string) {
  const stream = await openMachineStream(cronk, token);
  streams.push(stream);
  return stream;
}

const shown = async (ada: string) => (await ok("GET", "/api/machines", { cookie: ada }))[0];

const qwen = { name: "qwen", limit: 1, up: true };
const gptOss = { name: "gpt-oss", limit: 2, up: false };

test("a daemon that announces nothing counts as running Claude with no Machine models", async () => {
  const { ada, token } = await adaWithMachine();
  await connect(token);

  expect(await shown(ada)).toEqual(expect.objectContaining({ connected: true, claude: true, models: [] }));
});

test("an announcement is shown while connected, kept but not up while offline, and forgotten on unpairing", async () => {
  const { ada, machine, token } = await adaWithMachine();
  const stream = await connect(token);

  await ok("PUT", "/api/machine/announcement", { token, body: { claude: true, models: [qwen, gptOss] } });
  expect(await shown(ada)).toEqual(expect.objectContaining({ claude: true, models: [qwen, gptOss] }));

  stream.close();
  const offline = await eventually(async () => {
    const m = await shown(ada);
    return !m.connected && m;
  });
  expect(offline.models).toEqual([
    { name: "qwen", limit: 1, up: false },
    { name: "gpt-oss", limit: 2, up: false },
  ]);

  // Connecting again brings it back up, until the daemon announces otherwise.
  await connect(token);
  expect((await shown(ada)).models).toEqual([qwen, gptOss]);
  await ok("PUT", "/api/machine/announcement", { token, body: { claude: false, models: [gptOss] } });
  expect(await shown(ada)).toEqual(expect.objectContaining({ claude: false, models: [gptOss] }));

  await ok("DELETE", `/api/machines/${machine.id}`, { cookie: ada });
  // Paired again, the same computer starts from nothing announced.
  const started = await ok("POST", "/api/machines/pairings", { body: { name: "ada-laptop", os: "linux", daemonVersion: "0.3.0" } });
  const runners = await ok("GET", "/api/runners", { cookie: ada });
  await ok("POST", "/api/machines/pairings/approve", { cookie: ada, body: { userCode: started.userCode, runnerIds: [runners[0].id] } });
  expect(await shown(ada)).toEqual(expect.objectContaining({ claude: true, models: [] }));
  expect((await call("PUT", "/api/machine/announcement", { token, body: { claude: true, models: [] } })).status).toBe(401);
});

test("a changed announcement tells its Owner's stream which Runners changed; an unchanged one tells nothing", async () => {
  const { ada, runner, token } = await adaWithMachine();
  await connect(token);
  const stream = await openRunnerStream(cronk, ada);
  streams.push(stream);

  await ok("PUT", "/api/machine/announcement", { token, body: { claude: true, models: [qwen] } });
  expect(await stream.next()).toEqual({ type: "runner.changed", data: { runnerId: runner.id } });

  await ok("PUT", "/api/machine/announcement", { token, body: { claude: true, models: [qwen] } });
  await stream.expectQuiet(300);

  await ok("PUT", "/api/machine/announcement", { token, body: { claude: true, models: [{ ...qwen, up: false }] } });
  expect(await stream.next()).toEqual({ type: "runner.changed", data: { runnerId: runner.id } });
});

test("an announcement's shape is checked, and nothing but names, limits and up is kept", async () => {
  const { ada, token } = await adaWithMachine();
  await connect(token);

  for (const body of [
    { claude: true, models: [{ ...qwen, name: "Qwen" }] },
    { claude: true, models: [{ ...qwen, name: "" }] },
    { claude: true, models: [{ ...qwen, name: "a".repeat(51) }] },
    { claude: true, models: [{ ...qwen, limit: 0 }] },
    { claude: true, models: [{ name: "qwen", limit: 1 }] },
    { models: [] },
    { claude: true, models: Array.from({ length: 51 }, (_, i) => ({ name: `m${i}`, limit: 1, up: true })) },
  ]) {
    expect((await call("PUT", "/api/machine/announcement", { token, body })).status, JSON.stringify(body).slice(0, 80)).toBe(400);
  }
  const twice = await call("PUT", "/api/machine/announcement", { token, body: { claude: true, models: [qwen, qwen] } });
  expect(twice.status).toBe(400);
  expect(twice.json.error.code).toBe("duplicate_machine_model");

  // Whatever else a daemon sends, such as an address or a key, is dropped: only names, limits and up are kept.
  const secret = { ...qwen, address: "http://gpu.local:11434/v1", key: "sk-secret", modelId: "qwen3.5:9b" };
  await ok("PUT", "/api/machine/announcement", { token, body: { claude: true, models: [secret], key: "sk-other" } });
  const listed = await ok("GET", "/api/machines", { cookie: ada });
  expect(listed[0].models).toEqual([qwen]);
  for (const secretPart of ["sk-secret", "sk-other", "gpu.local", "qwen3.5"]) expect(JSON.stringify(listed)).not.toContain(secretPart);
});

test("announcing needs a Machine token, and another User's Machine isn't shown to anyone else", async () => {
  const { workspace, ada, token } = await adaWithMachine();
  expect((await call("PUT", "/api/machine/announcement", { body: { claude: true, models: [] } })).status).toBe(401);
  expect((await call("PUT", "/api/machine/announcement", { token: "cronk_machine_nope", body: { claude: true, models: [] } })).status).toBe(401);

  await ok("PUT", "/api/machine/announcement", { token, body: { claude: true, models: [qwen] } });
  const { cookie: bob } = await addMember(cronk, ada, workspace.id, "bob@example.com");
  expect(await ok("GET", "/api/machines", { cookie: bob })).toEqual([]);
});
