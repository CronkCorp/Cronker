#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { configPath } from "./config.js";
import { login } from "./login.js";
import { preflight } from "./preflight.js";
import { runDaemon } from "./run.js";
import { install, uninstall } from "./service.js";
import { status } from "./status.js";
import { daemonVersion } from "./version.js";

const usage = `cronk-runner ${daemonVersion}

Usage:
  cronk-runner login <cronk url>   Pair this Machine with a Cronk
  cronk-runner status              List the Cronks this Machine is paired with and the Runners it serves
  cronk-runner run                 Claim and run the Runs of the Runners this Machine serves, until stopped
  cronk-runner install             Run \`cronk-runner run\` as a service that starts at login (macOS and Linux)
  cronk-runner uninstall           Stop that service and remove it`;

/** Prints the preflight's problems, if any; whether there were none. */
async function ready(print: (line: string) => void): Promise<boolean> {
  const problems = await preflight();
  for (const problem of problems) print(problem);
  return problems.length === 0;
}

async function main(args: string[]): Promise<number> {
  const print = (line: string) => console.log(line);
  const [command, ...rest] = args;
  switch (command) {
    case "login": {
      const [url] = rest;
      if (!url) {
        console.error("Give the Cronk's address: cronk-runner login https://cronk.example.com");
        return 2;
      }
      await login(url, { configPath: configPath(), print });
      return 0;
    }
    case "status": {
      const isReady = await ready(print);
      const statuses = await status({ configPath: configPath(), print });
      return !isReady || statuses.some((s) => "error" in s) ? 1 : 0;
    }
    case "install":
      return install({
        home: homedir(),
        print,
        program: {
          node: process.execPath,
          script: realpathSync(fileURLToPath(import.meta.url)),
          path: process.env.PATH ?? "",
          configPath: configPath(),
        },
      });
    case "uninstall":
      return uninstall({ home: homedir(), print });
    case "run": {
      // Exiting with a failure lets the service manager show it, and restart it a little later.
      if (!(await ready((line) => console.error(line)))) return 1;
      const daemon = runDaemon({ configPath: configPath(), print });
      await new Promise<void>((resolve) => {
        const stop = () => void daemon.stop().then(resolve);
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      return 0;
    }
    case "--version":
    case "-v":
      print(daemonVersion);
      return 0;
    default:
      console.error(usage);
      return command === undefined || command === "--help" || command === "-h" ? 0 : 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error((error as Error).message);
    process.exit(1);
  },
);
