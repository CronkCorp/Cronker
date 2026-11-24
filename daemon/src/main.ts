#!/usr/bin/env node
import { configPath } from "./config.js";
import { login } from "./login.js";
import { runDaemon } from "./run.js";
import { status } from "./status.js";
import { daemonVersion } from "./version.js";

const usage = `cronk-runner ${daemonVersion}

Usage:
  cronk-runner login <cronk url>   Pair this Machine with a Cronk
  cronk-runner status              List the Cronks this Machine is paired with and the Runners it serves
  cronk-runner run                 Claim and run the Runs of the Runners this Machine serves, until stopped`;

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
      const statuses = await status({ configPath: configPath(), print });
      return statuses.some((s) => "error" in s) ? 1 : 0;
    }
    case "run": {
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
