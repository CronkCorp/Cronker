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

/**
 * A Machine model: a model served on the Machine, on its User's network or by a hosted API, offered to Cronk by name.
 * Its address, model id and key stay here: Cronk is told only its name, limit and whether it is up.
 */
export interface MachineModel {
  /** 1 to 50 lower case letters, digits and dashes. */
  name: string;
  /** The OpenAI-compatible server's address, such as `http://localhost:11434/v1`, without a trailing slash. */
  address: string;
  /** The model's id on that server, such as `qwen3.5:9b`. */
  modelId: string;
  /** The context size it is served with, in tokens. */
  contextSize: number;
  /** The key, kept here readable by its User alone; or `keyEnv` names the environment variable holding it. */
  key?: string;
  keyEnv?: string;
  /** The most Runs it runs at once on this Machine. */
  limit: number;
  /** How long one of its Runs may take, in minutes. */
  timeoutMinutes: number;
}

export interface Config {
  /** The most Runs the Machine runs at once, across all its Cronks and Runners. */
  limit: number;
  cronks: PairedCronk[];
  /** The Machine models it offers. */
  models: MachineModel[];
}

/** A Machine model's name: 1 to 50 lower case letters, digits and dashes. */
export const modelNamePattern = /^[a-z0-9-]{1,50}$/;

/** Throws unless the name is one a Machine model may have. */
export function checkModelName(name: string): void {
  if (!modelNamePattern.test(name)) {
    throw new Error(`${JSON.stringify(name)} isn't a Machine model's name: use 1 to 50 lower case letters, digits and dashes.`);
  }
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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { limit: defaultLimit, cronks: [], models: [] };
    throw error;
  }
  const parsed = JSON.parse(text) as Partial<Config>;
  const models = parsed.models ?? [];
  for (const model of models) checkModelName(model.name);
  return { limit: parsed.limit ?? defaultLimit, cronks: parsed.cronks ?? [], models };
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
