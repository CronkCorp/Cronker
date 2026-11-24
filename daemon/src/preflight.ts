import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";

/**
 * The preflight `install`, `run` and `status` share: the daemon runs Runs with `claude` and Repositories with `git`, so
 * both must be on its `PATH`, and Claude Code must be signed in. Each problem is one line naming what's missing and how
 * to put it right; none means the Machine is ready.
 */

export interface PreflightOptions {
  /** The environment to check, whose `PATH` the daemon runs with; the daemon's own when left out. */
  env?: NodeJS.ProcessEnv;
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

/** What `claude auth status` printed and how it exited. */
async function authStatus(claude: string, env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(claude, ["auth", "status", "--json"], { env, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.on("error", () => resolve({ code: -1, stdout }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout }));
  });
}

/** Whether Claude Code says it is signed in: `claude auth status` exits 0 and its JSON doesn't say `loggedIn: false`. */
async function signedIn(claude: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const { code, stdout } = await authStatus(claude, env);
  if (code !== 0) return false;
  try {
    return (JSON.parse(stdout) as { loggedIn?: unknown }).loggedIn !== false;
  } catch {
    return true;
  }
}

/** The problems keeping this Machine from running Runs, each a line saying what's missing and what to do. */
export async function preflight(options: PreflightOptions = {}): Promise<string[]> {
  const env = options.env ?? process.env;
  const problems: string[] = [];
  const claude = await findOnPath("claude", env);
  if (!claude) {
    problems.push(
      "`claude` isn't on the PATH: install Claude Code (https://claude.com/claude-code), then run this again from a shell that finds it.",
    );
  }
  if (!(await findOnPath("git", env))) {
    problems.push("`git` isn't on the PATH: install Git, then run this again from a shell that finds it.");
  }
  if (claude && !(await signedIn(claude, env))) {
    problems.push("Claude Code isn't signed in: run `claude auth login`, then run this again.");
  }
  return problems;
}
