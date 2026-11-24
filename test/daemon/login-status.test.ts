import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { login } from "../../daemon/src/login.js";
import { status } from "../../daemon/src/status.js";
import { setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

let cronk: StartedCronk;
let home: string;
let configPath: string;
beforeEach(async () => {
  cronk = await startCronk();
  home = await mkdtemp(join(tmpdir(), "cronk-runner-"));
  configPath = join(home, "cronk-runner", "config.json");
});
afterEach(async () => {
  await cronk?.stop();
  await rm(home, { recursive: true, force: true });
});

async function ok(method: string, path: string, cookie: string, body?: unknown) {
  const response = await cronk.request(method, path, { cookie, body });
  expect(response.status, `${method} ${path}`).toBeLessThan(300);
  return response.status === 204 ? null : response.json();
}

/** Ada, signed in, with `local` Runners by the names given. */
async function adaWithLocalRunners(...names: string[]) {
  await setUp(cronk);
  const ada = await signIn(cronk);
  const runners = [];
  for (const name of names) runners.push(await ok("POST", "/api/runners", ada, { name, kind: "local" }));
  return { ada, runners };
}

/**
 * Runs `cronk-runner login` against a Cronk, approving the code it prints as Ada on its second wait, after one poll
 * refused as pending, as she would on the Runners page; returns what it printed and how often it waited.
 */
async function loginApproving(url: string, ada: string, runnerIds: string[], approve = cronk) {
  const printed: string[] = [];
  let waits = 0;
  await login(url, {
    configPath,
    print: (line) => printed.push(line),
    name: "ada-laptop",
    os: "linux",
    sleep: async () => {
      waits++;
      if (waits !== 2) return;
      const userCode = /approve the code ([A-Z]{4}-[A-Z]{4})/.exec(printed.join("\n"))![1];
      const response = await approve.request("POST", "/api/machines/pairings/approve", { cookie: ada, body: { userCode, runnerIds } });
      expect(response.status).toBe(201);
    },
  });
  return { printed, waits };
}

describe("cronk-runner login", () => {
  test("shows a code and the Runners page, waits for approval and saves the Machine token readable only by its User", async () => {
    const { ada, runners } = await adaWithLocalRunners("Laptop");

    const { printed, waits } = await loginApproving(`${cronk.url}/`, ada, [runners[0].id]);

    expect(printed[0]).toBe(`To pair this Machine with ${cronk.url}, open ${cronk.url}/runners`);
    expect(printed[1]).toMatch(/^and approve the code [A-Z]{4}-[A-Z]{4}, picking the local Runners it serves\.$/);
    expect(printed.at(-1)).toBe(`Paired as ada-laptop. Its token is saved in ${configPath}.`);
    // It polled once before approval, refused as pending, kept waiting, and once after.
    expect(waits).toBe(2);

    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, "cronk-runner"))).mode & 0o777).toBe(0o700);
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const [machine] = await ok("GET", "/api/machines", ada);
    expect(config).toEqual({
      limit: 2,
      cronks: [{ url: cronk.url, machineId: machine.id, machineName: "ada-laptop", token: expect.stringMatching(/^cronk_machine_/) }],
    });
    expect(machine).toEqual(expect.objectContaining({ name: "ada-laptop", os: "linux", daemonVersion: "0.3.0", limit: 2 }));
  });

  test("pairs one Machine with several Cronks, keeping each in the config", async () => {
    const { ada, runners } = await adaWithLocalRunners("Laptop");
    const other = await startCronk();
    try {
      await setUp(other);
      const adaThere = await signIn(other);
      const response = await other.request("POST", "/api/runners", { cookie: adaThere, body: { name: "Laptop at work", kind: "local" } });
      const there = await response.json();

      await loginApproving(cronk.url, ada, [runners[0].id]);
      await loginApproving(other.url, adaThere, [there.id], other);

      const config = JSON.parse(await readFile(configPath, "utf8"));
      expect(config.cronks.map((c: { url: string }) => c.url)).toEqual([cronk.url, other.url]);

      const printed: string[] = [];
      const statuses = await status({ configPath, print: (line) => printed.push(line) });
      expect(statuses).toEqual([
        expect.objectContaining({ url: cronk.url, machine: expect.objectContaining({ runners: [{ id: runners[0].id, name: "Laptop" }] }) }),
        expect.objectContaining({ url: other.url, machine: expect.objectContaining({ runners: [{ id: there.id, name: "Laptop at work" }] }) }),
      ]);
    } finally {
      await other.stop();
    }
  });

  test("logging in to the same Cronk again replaces its entry", async () => {
    const { ada, runners } = await adaWithLocalRunners("Laptop");
    await loginApproving(cronk.url, ada, [runners[0].id]);
    const first = JSON.parse(await readFile(configPath, "utf8")).cronks[0];

    await loginApproving(cronk.url, ada, [runners[0].id]);

    const { cronks } = JSON.parse(await readFile(configPath, "utf8"));
    expect(cronks).toHaveLength(1);
    expect(cronks[0].token).not.toBe(first.token);
  });
});

describe("cronk-runner status", () => {
  test("lists each paired Cronk and the Runners the Machine serves there", async () => {
    const { ada, runners } = await adaWithLocalRunners("Laptop", "Side project");
    await loginApproving(cronk.url, ada, runners.map((r: { id: string }) => r.id));

    const printed: string[] = [];
    await status({ configPath, print: (line) => printed.push(line) });

    expect(printed).toEqual([
      "Runs at once on this Machine: at most 2.",
      `${cronk.url}: paired as ada-laptop for ada@example.com`,
      "  serves Laptop",
      "  serves Side project",
    ]);
  });

  test("says when a Cronk unpaired the Machine, as its token is refused", async () => {
    const { ada, runners } = await adaWithLocalRunners("Laptop");
    await loginApproving(cronk.url, ada, [runners[0].id]);
    const [machine] = await ok("GET", "/api/machines", ada);
    await ok("DELETE", `/api/machines/${machine.id}`, ada);

    const printed: string[] = [];
    const statuses = await status({ configPath, print: (line) => printed.push(line) });

    const message = `unpaired: run \`cronk-runner login ${cronk.url}\` again`;
    expect(statuses).toEqual([{ url: cronk.url, error: message }]);
    expect(printed.at(-1)).toBe(`${cronk.url}: ${message}`);
  });

  test("says when the Machine isn't paired with any Cronk", async () => {
    const printed: string[] = [];
    expect(await status({ configPath, print: (line) => printed.push(line) })).toEqual([]);
    expect(printed).toEqual(["This Machine isn't paired with any Cronk yet: run `cronk-runner login <url>`."]);
  });
});
