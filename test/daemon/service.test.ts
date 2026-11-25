import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { writeConfig } from "../../daemon/src/config.js";
import { checkMachine, preflight } from "../../daemon/src/preflight.js";
import {
  install,
  launchdPlist,
  systemdUnit,
  uninstall,
  type Exec,
  type ServiceProgram,
} from "../../daemon/src/service.js";

let home: string;
let bin: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cronk-runner-home-"));
  bin = join(home, "bin");
  await mkdir(bin);
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** Puts a stand-in executable on the test `PATH`. */
async function fake(name: string, script: string) {
  const file = join(bin, name);
  await writeFile(file, `#!/bin/sh\n${script}\n`);
  await chmod(file, 0o755);
}

const signedInClaude = `echo '{"loggedIn": true}'`;
const env = () => ({ PATH: bin });

/** Records the service manager commands instead of running them. */
function recorder(code = 0) {
  const calls: string[] = [];
  const exec: Exec = async (command, args) => {
    calls.push([command, ...args].join(" "));
    return { code, output: code === 0 ? "" : "boom" };
  };
  return { calls, exec };
}

const program = (): ServiceProgram => ({
  node: "/Users/ada/.nvm/versions/node/v22.11.0/bin/node",
  script: "/Users/ada/.nvm/versions/node/v22.11.0/lib/node_modules/cronk-runner/dist/main.js",
  path: `/Users/ada/.local/bin:/usr/bin:/bin`,
  configPath: "/Users/ada/.config/cronk-runner/config.json",
});

describe("preflight", () => {
  test("a Machine with claude signed in and git has no problems", async () => {
    await fake("claude", signedInClaude);
    await fake("git", "exit 0");
    expect(await preflight({ env: env() })).toEqual([]);
  });

  test("names a missing claude and a missing git", async () => {
    const problems = await preflight({ env: env() });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/`claude` isn't on the PATH/);
    expect(problems[1]).toMatch(/`git` isn't on the PATH/);
  });

  test("names a Claude Code that isn't signed in, by its JSON or its exit", async () => {
    await fake("git", "exit 0");
    await fake("claude", `echo '{"loggedIn": false}'`);
    expect(await preflight({ env: env() })).toEqual([expect.stringMatching(/Claude Code isn't signed in.*claude auth login/)]);
    await fake("claude", "exit 1");
    expect(await preflight({ env: env() })).toEqual([expect.stringMatching(/Claude Code isn't signed in/)]);
  });

  /** A config with the Machine model qwen set up, or none. */
  async function config(models: boolean): Promise<string> {
    const path = join(home, "config.json");
    const qwen = { name: "qwen", address: "http://localhost:11434/v1", modelId: "qwen3.5:9b", contextSize: 65536, limit: 1, timeoutMinutes: 60 };
    await writeConfig(path, { limit: 2, cronks: [], models: models ? [qwen] : [] });
    return path;
  }

  test.each([
    // [claude, opencode, Machine models, problems, notes]
    ["signed in", "2.4.0", true, [], []],
    ["signed in", null, true, [], [/OpenCode isn't on the PATH, so this Machine offers none of its Machine models: it keeps running Claude's Runs/]],
    ["signed in", "1.9.3", true, [], [/OpenCode is V1, and V2 is needed.*keeps running Claude's Runs/]],
    ["signed in", null, false, [], []],
    [null, "2.4.0", true, [], [/`claude` isn't on the PATH, so this Machine doesn't run Claude: it runs only Runs on its Machine models/]],
    ["signed out", "2.4.0", true, [], [/Claude Code isn't signed in, so this Machine doesn't run Claude/]],
    [null, "2.4.0", false, [/`claude` isn't on the PATH/], []],
    [null, null, true, [/`claude` isn't on the PATH/, /`opencode` isn't on the PATH.*install OpenCode V2/], []],
    [null, "1.9.3", true, [/`claude` isn't on the PATH/, /OpenCode is V1.*need V2/], []],
    ["signed out", null, false, [/Claude Code isn't signed in/], []],
  ] as const)("claude %s, opencode %s, Machine models %s", async (claude, opencode, models, problems, notes) => {
    await fake("git", "exit 0");
    if (claude) await fake("claude", `echo '{"loggedIn": ${claude === "signed in"}}'`);
    if (opencode) await fake("opencode", `echo '${opencode}'`);
    const checked = await checkMachine({ env: env(), configPath: await config(models) });
    expect(checked.problems).toEqual(problems.map((p) => expect.stringMatching(p)));
    expect(checked.notes).toEqual(notes.map((n) => expect.stringMatching(n)));
    // Without Machine models OpenCode is never named.
    if (!models) expect([...checked.problems, ...checked.notes].join("\n")).not.toMatch(/opencode/i);
  });

  test("git is needed whatever else the Machine has", async () => {
    await fake("claude", signedInClaude);
    await fake("opencode", "echo 2.4.0");
    expect((await checkMachine({ env: env(), configPath: await config(true) })).problems).toEqual([
      expect.stringMatching(/`git` isn't on the PATH/),
    ]);
  });

  test("an opencode that can't say its version counts as V1", async () => {
    await fake("git", "exit 0");
    await fake("opencode", "exit 1");
    const checked = await checkMachine({ env: env(), configPath: await config(true) });
    expect(checked.programs.openCode).toBe("v1");
  });

  test("a file on the PATH that isn't executable isn't found", async () => {
    await fake("git", "exit 0");
    await writeFile(join(bin, "claude"), "not a program");
    expect(await preflight({ env: env() })).toEqual([expect.stringMatching(/`claude` isn't on the PATH/)]);
  });
});

describe("the service files", () => {
  test("the launchd plist runs `cronk-runner run` at load, again after a crash, with its PATH and config", () => {
    const plist = launchdPlist(
      { ...program(), path: "/opt/a&b/bin:/usr/bin" },
      "/Users/ada/Library/Logs/cronk-runner.log",
    );
    expect(plist).toContain("<key>Label</key>\n  <string>net.cronk.runner</string>");
    expect(plist).toContain(
      [
        "<array>",
        `    <string>${program().node}</string>`,
        `    <string>${program().script}</string>`,
        "    <string>run</string>",
        "  </array>",
      ].join("\n"),
    );
    expect(plist).toContain("<key>PATH</key>\n    <string>/opt/a&amp;b/bin:/usr/bin</string>");
    expect(plist).toContain(`<key>CRONK_RUNNER_CONFIG</key>\n    <string>${program().configPath}</string>`);
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>");
    expect(plist).toContain("<string>/Users/ada/Library/Logs/cronk-runner.log</string>");
  });

  test("the systemd unit runs `cronk-runner run`, restarts on failure and starts at login", () => {
    const unit = systemdUnit({ ...program(), node: "/home/ada/my node/bin/node", path: "/home/ada/100%/bin:/usr/bin" });
    expect(unit).toContain(`ExecStart="/home/ada/my node/bin/node" "${program().script}" "run"`);
    expect(unit).toContain('Environment="PATH=/home/ada/100%%/bin:/usr/bin"');
    expect(unit).toContain(`Environment="CRONK_RUNNER_CONFIG=${program().configPath}"`);
    expect(unit).toContain("Restart=on-failure\nRestartSec=10");
    expect(unit).toContain("[Install]\nWantedBy=default.target");
  });

  test("systemd quoting escapes quotes, backslashes and $ in ExecStart", () => {
    const unit = systemdUnit({ ...program(), script: '/opt/$x/"a"\\b/main.js' });
    expect(unit).toContain('"/opt/$$x/\\"a\\"\\\\b/main.js"');
  });
});

describe("install and uninstall", () => {
  beforeEach(async () => {
    await fake("claude", signedInClaude);
    await fake("git", "exit 0");
  });

  test("on macOS, writes the launchd agent and loads it, and uninstall unloads and removes it", async () => {
    const { calls, exec } = recorder();
    const lines: string[] = [];
    const options = { platform: "darwin" as const, home, print: (l: string) => lines.push(l), exec, uid: 501 };
    expect(await install({ ...options, program: program(), env: env() })).toBe(0);
    const file = join(home, "Library", "LaunchAgents", "net.cronk.runner.plist");
    expect(await readFile(file, "utf8")).toBe(launchdPlist(program(), join(home, "Library", "Logs", "cronk-runner.log")));
    expect(calls).toEqual(["launchctl bootout gui/501/net.cronk.runner", `launchctl bootstrap gui/501 ${file}`]);
    expect(lines.join("\n")).toMatch(/launchd agent/);

    calls.length = 0;
    expect(await uninstall(options)).toBe(0);
    await expect(stat(file)).rejects.toThrow();
    expect(calls).toEqual(["launchctl bootout gui/501/net.cronk.runner"]);
  });

  test("on Linux, writes the systemd unit and enables it, and uninstall disables and removes it", async () => {
    const { calls, exec } = recorder();
    const options = { platform: "linux" as const, home, print: () => {}, exec };
    expect(await install({ ...options, program: program(), env: env() })).toBe(0);
    const file = join(home, ".config", "systemd", "user", "cronk-runner.service");
    expect(await readFile(file, "utf8")).toBe(systemdUnit(program()));
    expect(calls).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable cronk-runner.service",
      "systemctl --user restart cronk-runner.service",
    ]);

    calls.length = 0;
    expect(await uninstall(options)).toBe(0);
    await expect(stat(file)).rejects.toThrow();
    expect(calls).toEqual(["systemctl --user disable --now cronk-runner.service", "systemctl --user daemon-reload"]);
    // Uninstalling again, with nothing installed, still succeeds.
    expect(await uninstall(options)).toBe(0);
  });

  test("other platforms are refused with a clear message", async () => {
    const { calls, exec } = recorder();
    const lines: string[] = [];
    const print = (l: string) => lines.push(l);
    expect(await install({ platform: "win32", home, print, exec, program: program(), env: env() })).toBe(1);
    expect(await uninstall({ platform: "win32", home, print, exec })).toBe(1);
    expect(lines[0]).toMatch(/only be installed as a service on macOS \(launchd\) and Linux \(systemd\); this is win32/);
    expect(calls).toEqual([]);
  });

  test("refuses to install while the preflight finds a problem", async () => {
    await rm(join(bin, "git"));
    const { calls, exec } = recorder();
    const lines: string[] = [];
    expect(
      await install({ platform: "linux", home, print: (l) => lines.push(l), exec, program: program(), env: env() }),
    ).toBe(1);
    expect(lines).toEqual([expect.stringMatching(/`git` isn't on the PATH/), "Nothing was installed."]);
    await expect(stat(join(home, ".config", "systemd", "user", "cronk-runner.service"))).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  test("says so when the service manager fails to load it", async () => {
    const { exec } = recorder(1);
    const lines: string[] = [];
    expect(
      await install({ platform: "linux", home, print: (l) => lines.push(l), exec, program: program(), env: env() }),
    ).toBe(1);
    expect(lines).toEqual([expect.stringMatching(/`systemctl --user daemon-reload` failed: boom/)]);
  });
});
