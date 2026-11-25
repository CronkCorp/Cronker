#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { configPath } from "./config.js";
import { historyDirOf } from "./history.js";
import { login } from "./login.js";
import { followDaemonLog, followRun, followRunning } from "./logs.js";
import { addModel, listModels, removeModel, type ModelFlags } from "./models.js";
import { preflight } from "./preflight.js";
import { asker } from "./prompt.js";
import { runDaemon, stateDirOf } from "./run.js";
import { install, uninstall } from "./service.js";
import { status } from "./status.js";
import { daemonVersion } from "./version.js";

const usage = `cronk-runner ${daemonVersion}

Usage:
  cronk-runner login <cronk url>   Pair this Machine with a Cronk
  cronk-runner status              List the Cronks this Machine is paired with and the Runners it serves
  cronk-runner run                 Claim and run the Runs of the Runners this Machine serves, until stopped
  cronk-runner install             Run \`cronk-runner run\` as a service that starts at login (macOS and Linux)
  cronk-runner uninstall           Stop that service and remove it
  cronk-runner logs [<key|run id>] Follow the Runs running now, or one Run (also one that ended this past week)
      --raw                        Print Claude Code's JSONL as it is, instead of readable lines
      --daemon                     Follow the daemon's own log as a service instead
  cronk-runner model add <name>    Offer a Machine model: a model served on this Machine, your network or a hosted API
      --address <url>              Its OpenAI-compatible server, such as http://localhost:11434/v1
      --model-id <id>              Its id on that server, such as qwen3.5:9b
      --context-size <tokens>      The context size it is served with
      --limit <n>                  Runs at once on it (1 when not given)
      --time-limit <minutes>       How long one Run may take (60 when not given)
      --key-env <VARIABLE>         Read its key from this environment variable instead of asking for it
      --no-key                     It needs no key
  cronk-runner model list          List the Machine models, whether each is up, without their keys
  cronk-runner model remove <name> Stop offering a Machine model`;

/** The flags `model add` takes, each as \`--flag value\` or \`--flag=value\`, and which of them take a value. */
const modelFlags: Record<string, keyof ModelFlags> = {
  "--address": "address",
  "--model-id": "modelId",
  "--context-size": "contextSize",
  "--limit": "limit",
  "--time-limit": "timeoutMinutes",
  "--key-env": "keyEnv",
};

/** `model add`'s name and flags; null when they don't parse. */
function parseModelAdd(args: string[]): { name: string; flags: ModelFlags } | null {
  const flags: ModelFlags = {};
  const names: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--no-key") {
      flags.noKey = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      names.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    const flag = equals < 0 ? arg : arg.slice(0, equals);
    const field = modelFlags[flag];
    if (!field) return null;
    const value = equals < 0 ? args[++i] : arg.slice(equals + 1);
    if (value === undefined) return null;
    (flags as Record<string, string>)[field] = value;
  }
  return names.length === 1 ? { name: names[0]!, flags } : null;
}

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
    case "logs": {
      const flags = new Set(rest.filter((arg) => arg.startsWith("-")));
      const [target, ...extra] = rest.filter((arg) => !arg.startsWith("-"));
      const unknown = [...flags].filter((flag) => flag !== "--raw" && flag !== "--daemon");
      if (unknown.length || extra.length) {
        console.error(usage);
        return 2;
      }
      const note = (line: string) => console.error(line);
      if (flags.has("--daemon")) return followDaemonLog(homedir(), note);
      const abort = new AbortController();
      process.once("SIGINT", () => abort.abort());
      process.once("SIGTERM", () => abort.abort());
      const options = {
        historyDir: historyDirOf(stateDirOf(configPath())),
        env: process.env,
        print,
        note,
        raw: flags.has("--raw"),
        signal: abort.signal,
      };
      return target ? followRun(target, options) : followRunning(options);
    }
    case "model": {
      const [action, ...more] = rest;
      const options = { configPath: configPath(), print };
      if (action === "add") {
        const parsed = parseModelAdd(more);
        if (!parsed) break;
        const prompt = asker();
        try {
          return await addModel(parsed.name, parsed.flags, { ...options, ask: prompt.ask });
        } finally {
          prompt.close();
        }
      }
      if (action === "list" && more.length === 0) return listModels(options);
      if (action === "remove" && more.length === 1) return removeModel(more[0]!, options);
      break;
    }
    case "--version":
    case "-v":
      print(daemonVersion);
      return 0;
    default:
      console.error(usage);
      return command === undefined || command === "--help" || command === "-h" ? 0 : 2;
  }
  console.error(usage);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error((error as Error).message);
    process.exit(1);
  },
);
