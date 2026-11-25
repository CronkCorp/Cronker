import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { writeConfig } from "../../daemon/src/config.js";
import { addModel, listModels, removeModel, type ModelFlags } from "../../daemon/src/models.js";
import { runDaemon, type RunningDaemon } from "../../daemon/src/run.js";
import { setUp, signIn } from "../harness/flows.js";
import { standInModelServer, type StandInModelServer } from "../harness/model-server.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

/**
 * Seam 2: `cronk-runner model add|list|remove` and a running daemon announcing its Machine models (CRONK-154), against a
 * real Cronk and a stand-in model server.
 */

let home: string;
let configPath: string;
let server: StandInModelServer | undefined;
let cronk: StartedCronk | undefined;
let daemon: RunningDaemon | undefined;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cronk-runner-models-"));
  configPath = join(home, "cronk-runner", "config.json");
});
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  await cronk?.stop();
  cronk = undefined;
  await server?.stop();
  server = undefined;
  await rm(home, { recursive: true, force: true });
});

/** Answers each question in turn, recording what was asked and whether it was hidden. */
function answering(...answers: string[]) {
  const asked: { question: string; hidden: boolean }[] = [];
  return {
    asked,
    ask: async (question: string, options: { hidden?: boolean } = {}) => {
      asked.push({ question, hidden: options.hidden === true });
      const answer = answers.shift();
      if (answer === undefined) throw new Error(`unexpected question: ${question}`);
      return answer;
    },
  };
}

async function add(name: string, flags: ModelFlags, ...answers: string[]) {
  const printed: string[] = [];
  const asking = answering(...answers);
  const code = await addModel(name, flags, { configPath, print: (line) => printed.push(line), ask: asking.ask });
  return { code, printed, asked: asking.asked };
}

async function list(env: NodeJS.ProcessEnv = {}) {
  const printed: string[] = [];
  await listModels({ configPath, print: (line) => printed.push(line), env });
  return printed;
}

const config = async () => JSON.parse(await readFile(configPath, "utf8"));

describe("cronk-runner model", () => {
  test("add asks for what its flags don't give, the key hidden, with a limit of 1 and an hour unless told otherwise", async () => {
    server = await standInModelServer({ key: "sk-secret" });
    const added = await add("qwen", {}, `${server.address}/`, "qwen3.5:9b", "65536", "", "", "sk-secret");

    expect(added.code).toBe(0);
    expect(added.asked.map((a) => a.hidden)).toEqual([false, false, false, false, false, true]);
    expect(added.asked[5]!.question).toMatch(/^Key/);
    expect(added.printed).toEqual([expect.stringContaining("Added the Machine model qwen.")]);
    expect((await config()).models).toEqual([
      { name: "qwen", address: server.address, modelId: "qwen3.5:9b", contextSize: 65536, limit: 1, timeoutMinutes: 60, key: "sk-secret" },
    ]);
    // The config holds the key, so only its User may read it.
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, "cronk-runner"))).mode & 0o777).toBe(0o700);

    const printed = await list();
    expect(printed).toEqual([expect.stringMatching(/^qwen: up, qwen3\.5:9b at .*, context 65536, 1 at once, time limit 60 min, key saved$/)]);
    expect(printed.join("\n")).not.toContain("sk-secret");
    expect(server.requests.at(-1)).toEqual({ path: "/v1/models", authorization: "Bearer sk-secret" });
  });

  test("every answer but the key can be a flag; the key can be named as an environment variable, or be none", async () => {
    server = await standInModelServer({ key: "sk-from-env" });
    const flags = { address: server.address, modelId: "gpt-oss:20b", contextSize: "32768", limit: "2", timeoutMinutes: "30" };

    expect((await add("gpt-oss", { ...flags, keyEnv: "OPENAI_KEY" })).asked).toEqual([]);
    expect((await add("open", { ...flags, noKey: true })).asked).toEqual([]);
    expect((await config()).models).toEqual([
      { name: "gpt-oss", address: server.address, modelId: "gpt-oss:20b", contextSize: 32768, limit: 2, timeoutMinutes: 30, keyEnv: "OPENAI_KEY" },
      { name: "open", address: server.address, modelId: "gpt-oss:20b", contextSize: 32768, limit: 2, timeoutMinutes: 30 },
    ]);

    // The key is read from the environment when checking, never stored.
    const printed = await list({ OPENAI_KEY: "sk-from-env" });
    expect(printed[0]).toMatch(/^gpt-oss: up, .*key from \$OPENAI_KEY$/);
    expect(printed[1]).toMatch(/^open: down, .*no key$/);
    expect(JSON.stringify(await config())).not.toContain("sk-from-env");

    // Added again under the same name, it is replaced.
    expect((await add("open", { ...flags, limit: "3", noKey: true })).printed[0]).toContain("Replaced the Machine model open.");
    expect((await config()).models.map((m: { name: string; limit: number }) => [m.name, m.limit])).toEqual([
      ["gpt-oss", 2],
      ["open", 3],
    ]);
  });

  test("names are 1 to 50 lower case letters, digits and dashes, and answers are checked", async () => {
    const flags = { address: "http://localhost:11434/v1", modelId: "qwen", contextSize: "65536", limit: "1", timeoutMinutes: "60", noKey: true };
    for (const name of ["Qwen", "", "a".repeat(51), "qwen_3", "qwen 3"]) {
      await expect(add(name, flags)).rejects.toThrow(/isn't a Machine model's name/);
    }
    await expect(add("a".repeat(50), flags)).resolves.toEqual(expect.objectContaining({ code: 0 }));
    await expect(add("q", { ...flags, address: "ftp://x" })).rejects.toThrow(/http or https/);
    await expect(add("q", { ...flags, contextSize: "lots" })).rejects.toThrow(/context size/);
    await expect(add("q", { ...flags, limit: "0" })).rejects.toThrow(/Runs at once/);
    await expect(add("q", { ...flags, timeoutMinutes: "-5" })).rejects.toThrow(/time limit/);
    await expect(add("q", { ...flags, noKey: false, keyEnv: "not a name" })).rejects.toThrow(/environment variable/);
    await expect(add("q", { ...flags, address: undefined }, "")).rejects.toThrow(/Server address .* is needed/);
  });

  test("remove removes one, and list says when there are none", async () => {
    const flags = { address: "http://127.0.0.1:9/v1", modelId: "qwen", contextSize: "65536", limit: "1", timeoutMinutes: "60", noKey: true };
    await add("qwen", flags);
    await add("gpt", flags);

    expect(await removeModel("qwen", { configPath, print: () => {} })).toBe(0);
    expect((await config()).models.map((m: { name: string }) => m.name)).toEqual(["gpt"]);
    expect(await removeModel("qwen", { configPath, print: () => {} })).toBe(1);
    await removeModel("gpt", { configPath, print: () => {} });
    expect(await list()).toEqual(["No Machine models yet: add one with `cronk-runner model add <name>`."]);
  });
});

describe("cronk-runner run", () => {
  /** Ada with a `local` Runner, and the daemon's config pairing this Machine with Cronk to serve it. */
  async function paired() {
    cronk = await startCronk();
    await setUp(cronk);
    const ada = await signIn(cronk);
    const call = async (method: string, path: string, body?: unknown, cookie?: string) => {
      const response = await cronk!.request(method, path, { cookie, body });
      expect(response.status, `${method} ${path}`).toBeLessThan(300);
      return response.json();
    };
    const runner = await call("POST", "/api/runners", { name: "Laptop", kind: "local" }, ada);
    const started = await call("POST", "/api/machines/pairings", { name: "ada-laptop", os: "linux", daemonVersion: "0.3.0" });
    const machine = await call("POST", "/api/machines/pairings/approve", { userCode: started.userCode, runnerIds: [runner.id] }, ada);
    const { machineToken } = await call("POST", "/api/machines/pairings/poll", { deviceCode: started.deviceCode });
    await writeConfig(configPath, {
      limit: 2,
      cronks: [{ url: cronk.url, machineId: machine.id, machineName: "ada-laptop", token: machineToken }],
      models: [],
    });
    return { machines: async () => (await call("GET", "/api/machines", undefined, ada)) as { connected: boolean; claude: boolean; models: unknown[] }[] };
  }

  async function eventually<T>(check: () => Promise<T | undefined | false>, timeoutMs = 10_000): Promise<T> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() > until) throw new Error("timed out waiting");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  test("announces on connecting, picks up added and removed models and a server going down, and never sends an address, model id or key", async () => {
    const { machines } = await paired();
    server = await standInModelServer({ key: "sk-secret" });
    const printed: string[] = [];
    daemon = runDaemon({ configPath, print: (line) => printed.push(line), modelCheckMs: 100, cacheDir: join(home, "cache") });

    // Connected with no Machine models: it runs Claude and offers nothing else.
    const connected = await eventually(async () => (await machines()).find((m) => m.connected));
    expect(connected).toEqual(expect.objectContaining({ claude: true, models: [] }));

    // Added while it runs: offered within a check, without a restart.
    await add("qwen", { address: server.address, modelId: "qwen3.5:9b", contextSize: "65536", limit: "1", timeoutMinutes: "60" }, "sk-secret");
    await eventually(async () => (await machines())[0]!.models.length === 1);
    expect((await machines())[0]!.models).toEqual([{ name: "qwen", limit: 1, up: true }]);

    // Its server going down is announced, and coming back too.
    server.setUp(false);
    await eventually(async () => JSON.stringify((await machines())[0]!.models) === JSON.stringify([{ name: "qwen", limit: 1, up: false }]));
    server.setUp(true);
    await eventually(async () => JSON.stringify((await machines())[0]!.models) === JSON.stringify([{ name: "qwen", limit: 1, up: true }]));

    const shown = JSON.stringify(await machines());
    for (const secret of ["sk-secret", server.address, "qwen3.5:9b", "65536"]) expect(shown).not.toContain(secret);

    // Removed while it runs: no longer offered.
    await removeModel("qwen", { configPath, print: () => {} });
    await eventually(async () => (await machines())[0]!.models.length === 0);
    expect(printed.filter((line) => line.includes("couldn't announce"))).toEqual([]);
  });

  test("Cronk keeps the last announcement while the daemon is stopped, and hears it again when it starts", async () => {
    const { machines } = await paired();
    server = await standInModelServer();
    await add("qwen", { address: server.address, modelId: "qwen3.5:9b", contextSize: "65536", limit: "2", timeoutMinutes: "60", noKey: true });
    daemon = runDaemon({ configPath, print: () => {}, modelCheckMs: 60_000, cacheDir: join(home, "cache") });
    await eventually(async () => (await machines())[0]!.models.length === 1);
    await daemon.stop();
    daemon = undefined;

    const offline = await eventually(async () => (await machines()).find((m) => !m.connected));
    expect(offline.models).toEqual([{ name: "qwen", limit: 2, up: false }]);

    // Started again, it announces on connecting, though nothing changed and its next check is a minute away.
    daemon = runDaemon({ configPath, print: () => {}, modelCheckMs: 60_000, cacheDir: join(home, "cache") });
    await eventually(async () => {
      const [machine] = await machines();
      return machine!.connected && JSON.stringify(machine!.models) === JSON.stringify([{ name: "qwen", limit: 2, up: true }]);
    });
  });
});
