import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { readConfig } from "./config.js";

/**
 * The preflight `install`, `run` and `status` share. A Machine needs only the programs it uses: `git` always, for
 * Repositories, and then either Claude Code, on the `PATH` and signed in, for Runs on Claude, or OpenCode V2 with at
 * least one Machine model, for Runs on Machine models. Without Machine models OpenCode is never asked for. Each problem
 * is one line naming what's missing and how to put it right; none means the Machine is ready. Notes say what the
 * Machine leaves out while ready: Claude, or its Machine models.
 */

export interface PreflightOptions {
  /** The environment to check, whose `PATH` the daemon runs with; the daemon's own when left out. */
  env?: NodeJS.ProcessEnv;
  /** The daemon's config, whose Machine models need OpenCode; checked as having none when left out. */
  configPath?: string;
  /** The Claude Code executable; `claude` as the `PATH` finds it when left out. */
  claude?: string;
  /** The OpenCode executable; `opencode` as the `PATH` finds it when left out. */
  opencode?: string;
}

/** Whether Claude Code can run Runs here: `ok`, not on the `PATH`, or not signed in. */
export type ClaudeState = "ok" | "missing" | "signedOut";
/** Whether OpenCode can run Runs on Machine models here: `ok` (V2 or later), not on the `PATH`, or an older V1. */
export type OpenCodeState = "ok" | "missing" | "v1";

/** Which of the programs Runs run as this Machine can use now. */
export interface Programs {
  claude: ClaudeState;
  openCode: OpenCodeState;
}

export interface Preflight {
  /** What keeps the Machine from running any Run; none when it is ready. */
  problems: string[];
  /** What the Machine, ready, leaves out: Claude's Runs, or its Machine models. */
  notes: string[];
  programs: Programs;
}

/** The absolute path of the executable named, as `PATH` in `env` finds it, or null when it isn't on it. */
export async function findOnPath(name: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here: try the next directory.
    }
  }
  return null;
}

/** What the program printed and how it exited; -1 when it couldn't run or took over ten seconds. */
async function output(program: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(program, args, { env, stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.on("error", () => resolve({ code: -1, stdout }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout }));
  });
}

/** Whether Claude Code says it is signed in: `claude auth status` exits 0 and its JSON doesn't say `loggedIn: false`. */
async function signedIn(claude: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const { code, stdout } = await output(claude, ["auth", "status", "--json"], env);
  if (code !== 0) return false;
  try {
    return (JSON.parse(stdout) as { loggedIn?: unknown }).loggedIn !== false;
  } catch {
    return true;
  }
}

/** Whether `opencode --version` names V2 or later; a version it can't read counts as V1. */
async function openCodeVersion(opencode: string, env: NodeJS.ProcessEnv): Promise<OpenCodeState> {
  const { code, stdout } = await output(opencode, ["--version"], env);
  if (code === -1) return "missing";
  const major = /(\d+)\.\d+/.exec(stdout)?.[1];
  return code === 0 && major !== undefined && Number(major) >= 2 ? "ok" : "v1";
}

/** Which of Claude Code and OpenCode this Machine can use now. */
export async function checkPrograms(options: Omit<PreflightOptions, "configPath"> = {}): Promise<Programs> {
  const env = options.env ?? process.env;
  const [claude, opencode] = await Promise.all([
    options.claude ? options.claude : findOnPath("claude", env),
    options.opencode ? options.opencode : findOnPath("opencode", env),
  ]);
  const [claudeState, openCode] = await Promise.all([
    claude ? signedIn(claude, env).then((yes): ClaudeState => (yes ? "ok" : "signedOut")) : Promise.resolve<ClaudeState>("missing"),
    opencode ? openCodeVersion(opencode, env) : Promise.resolve<OpenCodeState>("missing"),
  ]);
  return { claude: claudeState, openCode };
}

const claudeProblem: Record<Exclude<ClaudeState, "ok">, string> = {
  missing:
    "`claude` isn't on the PATH: install Claude Code (https://claude.com/claude-code), then run this again from a shell that finds it.",
  signedOut: "Claude Code isn't signed in: run `claude auth login`, then run this again.",
};

const openCodeProblem: Record<Exclude<OpenCodeState, "ok">, string> = {
  missing:
    "`opencode` isn't on the PATH, and this Machine's Machine models run through it: install OpenCode V2 (https://opencode.ai), " +
    "then run this again from a shell that finds it.",
  v1: "OpenCode is V1, and this Machine's Machine models need V2: upgrade it (https://opencode.ai), then run this again.",
};

/** The preflight, with which programs the Machine can use and what it leaves out while ready. */
export async function checkMachine(options: PreflightOptions = {}): Promise<Preflight> {
  const env = options.env ?? process.env;
  const [programs, git, models] = await Promise.all([
    checkPrograms(options),
    findOnPath("git", env),
    options.configPath ? readConfig(options.configPath).then((config) => config.models.length) : Promise.resolve(0),
  ]);
  const problems: string[] = [];
  const notes: string[] = [];
  const claudeOk = programs.claude === "ok";
  const openCodeOk = models > 0 && programs.openCode === "ok";
  if (!claudeOk && !openCodeOk) {
    problems.push(claudeProblem[programs.claude as Exclude<ClaudeState, "ok">]);
    if (models > 0) problems.push(openCodeProblem[programs.openCode as Exclude<OpenCodeState, "ok">]);
  }
  if (!git) problems.push("`git` isn't on the PATH: install Git, then run this again from a shell that finds it.");
  if (claudeOk && models > 0 && programs.openCode !== "ok") {
    notes.push(
      `${programs.openCode === "missing" ? "OpenCode isn't on the PATH" : "OpenCode is V1, and V2 is needed"}, so this Machine ` +
        "offers none of its Machine models: it keeps running Claude's Runs. Install OpenCode V2 (https://opencode.ai) to offer them.",
    );
  }
  if (!claudeOk && openCodeOk) {
    notes.push(
      `${programs.claude === "missing" ? "`claude` isn't on the PATH" : "Claude Code isn't signed in"}, so this Machine doesn't run ` +
        "Claude: it runs only Runs on its Machine models.",
    );
  }
  return { problems, notes, programs };
}

/** The problems keeping this Machine from running Runs, each a line saying what's missing and what to do. */
export async function preflight(options: PreflightOptions = {}): Promise<string[]> {
  return (await checkMachine(options)).problems;
}
