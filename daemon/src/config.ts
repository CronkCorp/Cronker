import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The daemon's config: one entry per Cronk installation the Machine is paired with, each with its Machine token, and
 * the Machine's limit on Runs at once. It holds secrets, so it is written readable by its User alone.
 */
export interface PairedCronk {
  /** The Cronk's address, such as `https://cronk.example.com`, without a trailing slash. */
  url: string;
  machineId: string;
  machineName: string;
  token: string;
}

export interface Config {
  /** The most Runs the Machine runs at once, across all its Cronks and Runners. */
  limit: number;
  cronks: PairedCronk[];
}

export const defaultLimit = 2;

/**
 * Where the config lives: `$CRONK_RUNNER_CONFIG` when set, else `cronk-runner/config.json` under
 * `$XDG_CONFIG_HOME`, else under `~/.config`.
 */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CRONK_RUNNER_CONFIG) return env.CRONK_RUNNER_CONFIG;
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "cronk-runner", "config.json");
}

/** The config at the path, or an empty one when there is none yet. */
export async function readConfig(path: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { limit: defaultLimit, cronks: [] };
    throw error;
  }
  const parsed = JSON.parse(text) as Partial<Config>;
  return { limit: parsed.limit ?? defaultLimit, cronks: parsed.cronks ?? [] };
}

/**
 * Writes the config readable and writable by its User alone (mode 0600), in a directory only they can enter (0700),
 * replacing the old file in one step so a crash never leaves half a config.
 */
export async function writeConfig(path: string, config: Config): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

/** A Cronk's address as the config keys it: its origin and path, without a trailing slash. */
export function normaliseUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error(`${url} isn't an http or https address.`);
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

/** The config with the Cronk's entry added, replacing any for the same address. */
export function withCronk(config: Config, cronk: PairedCronk): Config {
  return { ...config, cronks: [...config.cronks.filter((c) => c.url !== cronk.url), cronk] };
}
