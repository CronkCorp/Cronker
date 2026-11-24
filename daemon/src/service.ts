import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { preflight } from "./preflight.js";

/**
 * `cronk-runner install` and `uninstall`: the daemon as a background service that starts at login and comes back when
 * it crashes, a launchd agent on macOS and a systemd `--user` service on Linux. Writing the service's file is apart
 * from loading it into the service manager, so tests check the files without installing anything.
 */

/** What the service runs: the absolute paths of Node and of the daemon's `main.js`, and the environment it keeps. */
export interface ServiceProgram {
  node: string;
  script: string;
  /** The `PATH` the service runs with: the one `install` ran with, since service managers don't read the login shell's. */
  path: string;
  /** The daemon's config file, so the service reads the one `login` wrote. */
  configPath: string;
}

export const launchdLabel = "net.cronk.runner";
export const systemdUnitName = "cronk-runner.service";

/** Runs a service manager command, such as `launchctl` or `systemctl`; resolves with its exit code and what it printed. */
export type Exec = (command: string, args: string[]) => Promise<{ code: number; output: string }>;

export interface ServiceOptions {
  /** `process.platform` when left out. */
  platform?: NodeJS.Platform;
  home: string;
  print: (line: string) => void;
  exec?: Exec;
}

export interface InstallOptions extends ServiceOptions {
  program: ServiceProgram;
  /** The environment the preflight checks: the daemon's own when left out. */
  env?: NodeJS.ProcessEnv;
  /** The user id launchd's `gui/<uid>` domain names; `process.getuid()` when left out. */
  uid?: number;
}

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** The launchd agent's plist: started at load, started again unless it exited cleanly, logging to `logPath`. */
export function launchdPlist(program: ServiceProgram, logPath: string): string {
  const string = (text: string) => `<string>${escapeXml(text)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${string(launchdLabel)}
  <key>ProgramArguments</key>
  <array>
    ${string(program.node)}
    ${string(program.script)}
    ${string("run")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    ${string(program.path)}
    <key>CRONK_RUNNER_CONFIG</key>
    ${string(program.configPath)}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  ${string(logPath)}
  <key>StandardErrorPath</key>
  ${string(logPath)}
</dict>
</plist>
`;
}

/** A value in double quotes as systemd reads it: backslashes and quotes escaped, `%` specifiers doubled. */
function systemdQuote(text: string, { variables }: { variables: boolean }): string {
  let escaped = text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  if (variables) escaped = escaped.replaceAll("$", "$$$$");
  return `"${escaped}"`;
}

/** The systemd `--user` unit: started at login, restarted ten seconds after it fails. */
export function systemdUnit(program: ServiceProgram): string {
  const execStart = [program.node, program.script, "run"].map((part) => systemdQuote(part, { variables: true })).join(" ");
  return `[Unit]
Description=cronk-runner: runs Cronk's Runs on this Machine
Wants=network-online.target
After=network-online.target

[Service]
ExecStart=${execStart}
Environment=${systemdQuote(`PATH=${program.path}`, { variables: false })}
Environment=${systemdQuote(`CRONK_RUNNER_CONFIG=${program.configPath}`, { variables: false })}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
}

/** Where the service's file goes on the platform, or null for a platform the daemon can't be installed on. */
export function serviceFile(platform: NodeJS.Platform, home: string): string | null {
  if (platform === "darwin") return join(home, "Library", "LaunchAgents", `${launchdLabel}.plist`);
  if (platform === "linux") return join(home, ".config", "systemd", "user", systemdUnitName);
  return null;
}

const unsupported = (platform: string) =>
  `cronk-runner can only be installed as a service on macOS (launchd) and Linux (systemd); this is ${platform}. ` +
  "Run `cronk-runner run` in a terminal instead.";

/** Runs a command, never throwing: a command that can't start resolves with code -1. */
export const spawnExec: Exec = (command, args) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", (error) => resolve({ code: -1, output: error.message }));
    child.on("close", (code) => resolve({ code: code ?? -1, output }));
  });

/**
 * Installs the daemon as a service and starts it, replacing one installed before: refused on other platforms and while
 * the preflight finds a problem. Returns the exit code.
 */
export async function install(options: InstallOptions): Promise<number> {
  const { home, print, program } = options;
  const platform = options.platform ?? process.platform;
  const exec = options.exec ?? spawnExec;
  const file = serviceFile(platform, home);
  if (!file) {
    print(unsupported(platform));
    return 1;
  }
  const problems = await preflight({ env: options.env });
  if (problems.length > 0) {
    for (const problem of problems) print(problem);
    print("Nothing was installed.");
    return 1;
  }
  await mkdir(dirname(file), { recursive: true });
  if (platform === "darwin") {
    const logPath = join(home, "Library", "Logs", "cronk-runner.log");
    await mkdir(dirname(logPath), { recursive: true });
    const domain = `gui/${options.uid ?? process.getuid?.() ?? 0}`;
    // Unloading a service that isn't loaded fails, which is fine: it's for reinstalling over one that is.
    await exec("launchctl", ["bootout", `${domain}/${launchdLabel}`]);
    await writeFile(file, launchdPlist(program, logPath));
    const loaded = await exec("launchctl", ["bootstrap", domain, file]);
    if (loaded.code !== 0) {
      print(`Wrote ${file}, but launchctl couldn't load it: ${loaded.output.trim()}`);
      return 1;
    }
    print(`Installed and started cronk-runner as a launchd agent (${file}). It logs to ${logPath}.`);
  } else {
    await writeFile(file, systemdUnit(program));
    for (const args of [["daemon-reload"], ["enable", systemdUnitName], ["restart", systemdUnitName]]) {
      const result = await exec("systemctl", ["--user", ...args]);
      if (result.code !== 0) {
        print(`Wrote ${file}, but \`systemctl --user ${args.join(" ")}\` failed: ${result.output.trim()}`);
        return 1;
      }
    }
    print(`Installed and started cronk-runner as a systemd user service (${file}).`);
    print(`See it with \`systemctl --user status ${systemdUnitName}\` and its log with \`journalctl --user -u ${systemdUnitName}\`.`);
    print("To keep it running while you're logged out, run `loginctl enable-linger` once.");
  }
  print("After upgrading cronk-runner or Node, run `cronk-runner install` again.");
  return 0;
}

/** Stops the service and removes its file; succeeds when there is none. Returns the exit code. */
export async function uninstall(options: ServiceOptions & { uid?: number }): Promise<number> {
  const { home, print } = options;
  const platform = options.platform ?? process.platform;
  const exec = options.exec ?? spawnExec;
  const file = serviceFile(platform, home);
  if (!file) {
    print(unsupported(platform));
    return 1;
  }
  if (platform === "darwin") {
    await exec("launchctl", ["bootout", `gui/${options.uid ?? process.getuid?.() ?? 0}/${launchdLabel}`]);
    await rm(file, { force: true });
  } else {
    await exec("systemctl", ["--user", "disable", "--now", systemdUnitName]);
    await rm(file, { force: true });
    await exec("systemctl", ["--user", "daemon-reload"]);
  }
  print(`Uninstalled cronk-runner's service (${file}).`);
  return 0;
}
