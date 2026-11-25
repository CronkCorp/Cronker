import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  return addWith({}, name, flags, ...answers);
}

async function addWith(env: NodeJS.ProcessEnv, name: string, flags: ModelFlags, ...answers: string[]) {
  const printed: string[] = [];
  const asking = answering(...answers);
  const code = await addModel(name, flags, {
    configPath,
    env,
    print: (line) => printed.push(line),
    ask: asking.ask,
    check: { toolsTimeoutMs: 5_000, contextTimeoutMs: 5_000 },
  });
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
    expect(added.printed.at(-1)).toContain("Added the Machine model qwen.");
    expect((await config()).models).toEqual([
      { name: "qwen", address: server.address, modelId: "qwen3.5:9b", contextSize: 65536, limit: 1, timeoutMinutes: 60, key: "sk-secret" },
    ]);
    // The config holds the key, so only its User may read it.
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, "cronk-runner"))).mode & 0o777).toBe(0o700);

    const printed = await list();
    expect(printed).toEqual([expect.stringMatching(/^qwen: up, qwen3\.5:9b at .*, context 65536, 1 at once, time limit 60 min, key saved$/)]);
    expect([...printed, ...added.printed].join("\n")).not.toContain("sk-secret");
    expect(server.requests.at(-1)).toEqual({ path: "/v1/models", authorization: "Bearer sk-secret" });
  });

  test("every answer but the key can be a flag; the key can be named as an environment variable, or be none", async () => {
    server = await standInModelServer({ key: "sk-from-env" });
    const flags = { address: server.address, modelId: "gpt-oss:20b", contextSize: "32768", limit: "2", timeoutMinutes: "30" };

    expect((await addWith({ OPENAI_KEY: "sk-from-env" }, "gpt-oss", { ...flags, keyEnv: "OPENAI_KEY" })).asked).toEqual([]);
    // The server wants a key this one lacks, so it is saved only because it is told to.
    expect((await add("open", { ...flags, noKey: true, saveAnyway: true })).asked).toEqual([]);
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
    expect((await add("open", { ...flags, limit: "3", noKey: true, saveAnyway: true })).printed.at(-1)).toContain("Replaced the Machine model open.");
    expect((await config()).models.map((m: { name: string; limit: number }) => [m.name, m.limit])).toEqual([
      ["gpt-oss", 2],
      ["open", 3],
    ]);
  });

  test("names are 1 to 50 lower case letters, digits and dashes, and answers are checked", async () => {
    const flags = { address: "http://127.0.0.1:9/v1", modelId: "qwen", contextSize: "65536", limit: "1", timeoutMinutes: "60", noKey: true, saveAnyway: true };
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

  describe("add checks the server before saving", () => {
    const flags = (address: string): ModelFlags => ({ address, modelId: "qwen3.5:9b", contextSize: "32768", limit: "1", timeoutMinutes: "60" });
    const saved = async () => {
      try {
        return (await config()).models.map((m: { name: string }) => m.name);
      } catch {
        return [];
      }
    };
    /** What the checks printed and asked, which must never hold the key. */
    const shown = (added: { printed: string[]; asked: { question: string }[] }) =>
      [...added.printed, ...added.asked.map((a) => a.question)].join("\n");

    test("a server that calls tools and keeps its context passes, and the model is saved without a question", async () => {
      server = await standInModelServer({ key: "sk-secret" });
      const added = await add("qwen", flags(server.address), "sk-secret");

      expect(added.code).toBe(0);
      expect(added.asked.map((a) => a.question)).toEqual([expect.stringMatching(/^Key/)]);
      expect(await saved()).toEqual(["qwen"]);
      const chats = server.requests.filter((r) => r.path === "/v1/chat/completions");
      expect(chats).toHaveLength(2);
      for (const chat of chats) expect(chat.authorization).toBe("Bearer sk-secret");
      // One asks for a tool call; the other is a prompt close to the context size, the marker at its very start.
      const [tools, context] = chats.map((c) => c.body as { model: string; tools?: unknown[]; messages: { content: string }[] });
      expect(tools!.model).toBe("qwen3.5:9b");
      expect(tools!.tools).toHaveLength(1);
      const prompt = context!.messages[0]!.content;
      expect(prompt).toMatch(/^Remember this marker: MARKER-[0-9a-f]{8}\b/);
      const words = prompt.split(/\s+/).length;
      expect(words).toBeGreaterThan(32768 * 0.8);
      expect(words).toBeLessThan(32768 * 0.9);
      expect(shown(added)).not.toContain("sk-secret");
    });

    test("a model answering without the tool call fails, and declining to save writes nothing", async () => {
      server = await standInModelServer({ tools: "refuse" });
      const added = await add("qwen", { ...flags(server.address), noKey: true }, "n");

      expect(added.code).toBe(1);
      expect(shown(added)).toContain("answered without calling the tool");
      expect(shown(added)).toContain("tool support");
      expect(added.asked.at(-1)!.question).toMatch(/Save anyway\? \[y\/N\]/);
      expect(await saved()).toEqual([]);
    });

    test("a server that silently loads a smaller context loses the marker, names Ollama's setting, and saves on a yes", async () => {
      server = await standInModelServer({ key: "sk-secret", loadedContext: 4096 });
      const added = await add("qwen", flags(server.address), "sk-secret", "y");

      expect(added.code).toBe(0);
      const text = shown(added);
      expect(text).toContain("lost the marker");
      expect(text).toContain("the server saw 4096");
      expect(text).toContain("OLLAMA_CONTEXT_LENGTH=32768");
      expect(text).toContain("num_ctx");
      expect(text).not.toContain("answered without calling the tool");
      expect(text).not.toContain("sk-secret");
      expect(await saved()).toEqual(["qwen"]);
    });

    test("a server refusing the length fails, its message shown without the key it echoed, and --save-anyway saves without asking", async () => {
      server = await standInModelServer({ key: "sk-secret", loadedContext: 4096, refuseLength: true });
      const added = await addWith({ MODEL_KEY: "sk-secret" }, "qwen", { ...flags(server.address), keyEnv: "MODEL_KEY", saveAnyway: true });

      expect(added.code).toBe(0);
      expect(added.asked).toEqual([]);
      const text = shown(added);
      expect(text).toContain("refused a prompt");
      expect(text).toContain("maximum context length");
      expect(text).toContain("Bearer ***");
      expect(text).toContain("OLLAMA_CONTEXT_LENGTH");
      expect(text).not.toContain("sk-secret");
      expect(await saved()).toEqual(["qwen"]);
    });

    test("a server that is down, or can't be reached, is a failed check like any other", async () => {
      server = await standInModelServer({ key: "sk-secret" });
      server.setUp(false);
      const down = await add("qwen", flags(server.address), "sk-secret", "");
      expect(down.code).toBe(1);
      expect(shown(down)).toContain("answered 503: loading");
      expect(shown(down)).toContain("Start the server");
      // The long request isn't made: it would only say the same.
      expect(server.requests.filter((r) => r.path === "/v1/chat/completions")).toHaveLength(1);
      expect(shown(down)).not.toContain("sk-secret");

      const unreachable = await add("gone", { ...flags("http://127.0.0.1:9/v1"), noKey: true }, "yes");
      expect(unreachable.code).toBe(0);
      expect(shown(unreachable)).toContain("can't be reached");
      expect(await saved()).toEqual(["gone"]);
    });

    test("with no answer to the question, as when its input ended, nothing is saved", async () => {
      server = await standInModelServer({ tools: "refuse" });
      const added = await add("qwen", { ...flags(server.address), noKey: true });
      expect(added.code).toBe(1);
      expect(await saved()).toEqual([]);
    });
  });

  test("remove removes one, and list says when there are none", async () => {
    const flags = { address: "http://127.0.0.1:9/v1", modelId: "qwen", contextSize: "65536", limit: "1", timeoutMinutes: "60", noKey: true, saveAnyway: true };
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

  /**
   * The daemon's environment: a PATH of stand-ins, `git`, a `claude` signed in unless `claude` says otherwise, and an
   * `opencode` printing `opencode` as its version unless it is null.
   */
  async function programs({ claude = "signedIn", opencode = "2.4.0" as string | null } = {}): Promise<NodeJS.ProcessEnv> {
    const bin = join(home, "bin");
    await rm(bin, { recursive: true, force: true });
    await mkdir(bin);
    const fake = async (name: string, script: string) => {
      await writeFile(join(bin, name), `#!/bin/sh\n${script}\n`);
      await chmod(join(bin, name), 0o755);
    };
    await fake("git", "exit 0");
    if (claude === "signedIn") await fake("claude", `echo '{"loggedIn": true}'`);
    if (claude === "signedOut") await fake("claude", `echo '{"loggedIn": false}'`);
    if (opencode !== null) await fake("opencode", `echo '${opencode}'`);
    return { PATH: bin };
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
    daemon = runDaemon({ configPath, print: (line) => printed.push(line), modelCheckMs: 100, cacheDir: join(home, "cache"), env: await programs() });

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
    const env = await programs();
    daemon = runDaemon({ configPath, print: () => {}, modelCheckMs: 60_000, cacheDir: join(home, "cache"), env });
    await eventually(async () => (await machines())[0]!.models.length === 1);
    await daemon.stop();
    daemon = undefined;

    const offline = await eventually(async () => (await machines()).find((m) => !m.connected));
    expect(offline.models).toEqual([{ name: "qwen", limit: 2, up: false }]);

    // Started again, it announces on connecting, though nothing changed and its next check is a minute away.
    daemon = runDaemon({ configPath, print: () => {}, modelCheckMs: 60_000, cacheDir: join(home, "cache"), env });
    await eventually(async () => {
      const [machine] = await machines();
      return machine!.connected && JSON.stringify(machine!.models) === JSON.stringify([{ name: "qwen", limit: 2, up: true }]);
    });
  });
  test("announces whether it runs Claude and offers its Machine models as up only with OpenCode V2, picking up a change within a check", async () => {
    const { machines } = await paired();
    server = await standInModelServer();
    await add("qwen", { address: server.address, modelId: "qwen3.5:9b", contextSize: "65536", limit: "1", timeoutMinutes: "60", noKey: true });
    const announced = async () => {
      const [machine] = await machines();
      return machine?.connected ? JSON.stringify({ claude: machine.claude, models: machine.models }) : undefined;
    };
    const expecting = (claude: boolean, up: boolean) => JSON.stringify({ claude, models: [{ name: "qwen", limit: 1, up }] });

    // Claude Code and OpenCode V2: both.
    daemon = runDaemon({ configPath, print: () => {}, modelCheckMs: 100, cacheDir: join(home, "cache"), env: await programs() });
    await eventually(async () => (await announced()) === expecting(true, true));

    // OpenCode V1, then none: its Machine models are still set up, but none is up; it keeps running Claude.
    await programs({ opencode: "1.9.3" });
    await eventually(async () => (await announced()) === expecting(true, false));
    await programs({ opencode: null });
    await eventually(async () => (await announced()) === expecting(true, false));

    // Claude Code signed out, or gone, with OpenCode V2: it says it doesn't run Claude.
    await programs({ claude: "signedOut" });
    await eventually(async () => (await announced()) === expecting(false, true));
    await programs({ claude: "missing" });
    await eventually(async () => (await announced()) === expecting(false, true));
  });

  test("a Machine without Claude claims no Run needing Claude: the Run waits for one that runs it", async () => {
    cronk = await startCronk();
    const { workspace } = await setUp(cronk);
    const ada = await signIn(cronk);
    const call = async (method: string, path: string, body?: unknown, cookie = ada) => {
      const response = await cronk!.request(method, path, { cookie, body });
      expect(response.status, `${method} ${path}`).toBeLessThan(300);
      return response.json();
    };
    const runner = await call("POST", "/api/runners", { name: "Laptop", kind: "local" });
    const agent = await call("POST", `/api/workspaces/${workspace.id}/agents`, { name: "laptop" });
    await call("PATCH", `/api/agents/${agent.id}`, { runnerId: runner.id });
    const project = await call("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
    const triage = project.statuses.find((s: { name: string }) => s.name === "Triage").id as string;
    const pair = async (name: string) => {
      const started = await call("POST", "/api/machines/pairings", { name, os: "linux", daemonVersion: "0.3.0" }, undefined);
      const machine = await call("POST", "/api/machines/pairings/approve", { userCode: started.userCode, runnerIds: [runner.id] });
      const { machineToken } = await call("POST", "/api/machines/pairings/poll", { deviceCode: started.deviceCode }, undefined);
      return { url: cronk!.url, machineId: machine.id, machineName: name, token: machineToken };
    };
    // Another Machine runs Claude, but is offline: it announced so, then stopped.
    const other = await pair("ada-desktop");
    const otherConfig = join(home, "other.json");
    await writeConfig(otherConfig, { limit: 2, cronks: [other], models: [] });
    const withClaude = await programs();
    daemon = runDaemon({ configPath: otherConfig, print: () => {}, cacheDir: join(home, "cache"), env: withClaude });
    await eventually(async () => {
      const list = (await call("GET", "/api/machines")) as { name: string; connected: boolean }[];
      return list.find((m) => m.name === "ada-desktop")?.connected;
    });
    await daemon.stop();

    // This Machine runs no Claude: it connects and announces so.
    await writeConfig(configPath, { limit: 2, cronks: [await pair("ada-laptop")], models: [] });
    const printed: string[] = [];
    const bin = join(home, "laptop-bin");
    await mkdir(bin);
    await writeFile(join(bin, "git"), "#!/bin/sh\nexit 0\n");
    await chmod(join(bin, "git"), 0o755);
    daemon = runDaemon({ configPath, print: (line) => printed.push(line), cacheDir: join(home, "cache"), env: { PATH: bin } });
    await eventually(async () => {
      const list = (await call("GET", "/api/machines")) as { name: string; connected: boolean; claude: boolean }[];
      const laptop = list.find((m) => m.name === "ada-laptop");
      return laptop?.connected && !laptop.claude;
    });

    const ticket = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Needs Claude" });
    await call("PATCH", `/api/tickets/${ticket.id}`, { delegateId: agent.id, statusId: triage });
    const waiting = await eventually(async () => {
      const read = await call("GET", `/api/tickets/${ticket.id}`);
      return read.waiting === "claude" && read;
    });
    expect(waiting.waiting).toBe("claude");
    expect(await call("GET", `/api/tickets/${ticket.id}/runs`)).toEqual([]);
    expect(printed.filter((line) => line.includes("couldn't claim"))).toEqual([]);
  });
});
