import { checkModelName, readConfig, writeConfig, type MachineModel } from "./config.js";
import { checkModelWorks, type CheckOptions } from "./model-check.js";
import type { Programs } from "./preflight.js";

/**
 * `cronk-runner model add|list|remove`: the Machine models this Machine offers, kept in the daemon's config, which
 * stays readable by its User alone. A running daemon reads them again about once a minute and announces their names,
 * limits and whether each is up to its Cronks; their addresses, model ids and keys never leave the Machine.
 */

/** The answers `model add` takes as flags; any missing is asked for. The key is never a flag. */
export interface ModelFlags {
  address?: string;
  modelId?: string;
  contextSize?: string;
  limit?: string;
  timeoutMinutes?: string;
  /** The name of the environment variable holding the key, stored in place of the key. */
  keyEnv?: string;
  /** The model needs no key: don't ask for one. */
  noKey?: boolean;
  /** Save it even when the server fails the checks, without asking. */
  saveAnyway?: boolean;
}

export interface ModelOptions {
  configPath: string;
  print: (line: string) => void;
  /** The environment a key named by `keyEnv` is read from; the daemon's own when left out. */
  env?: NodeJS.ProcessEnv;
}

export interface AddOptions extends ModelOptions {
  /** Asks a question and answers what was typed; `hidden` doesn't echo it, as for a key. */
  ask: (question: string, options?: { hidden?: boolean }) => Promise<string>;
  /** How the server is checked before saving; the checks' own timeouts when left out. */
  check?: Omit<CheckOptions, "note">;
}

export const defaultModelLimit = 1;
export const defaultTimeoutMinutes = 60;
/** How long the light request checking a model's server may take before it counts as down. */
const checkTimeoutMs = 5_000;
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A server's address as kept: an http or https address without a trailing slash. */
function normaliseAddress(address: string): string {
  let parsed: URL;
  try {
    parsed = new URL(address.trim());
  } catch {
    throw new Error(`${JSON.stringify(address)} isn't an address: give one such as http://localhost:11434/v1.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${address} isn't an http or https address.`);
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

function wholeNumber(value: string, what: string, least: number, most: number): number {
  const number = Number(value.trim());
  if (!Number.isInteger(number) || number < least || number > most) {
    throw new Error(`${what} must be a whole number from ${least} to ${most}, not ${JSON.stringify(value)}.`);
  }
  return number;
}

/** Sets up a Machine model, asking for what the flags don't give, and saves it, replacing one of the same name. */
export async function addModel(name: string, flags: ModelFlags, options: AddOptions): Promise<number> {
  checkModelName(name);
  const { ask, print } = options;
  const answer = async (given: string | undefined, question: string, fallback?: string): Promise<string> => {
    if (given !== undefined) return given;
    const typed = (await ask(fallback === undefined ? `${question}: ` : `${question} [${fallback}]: `)).trim();
    if (typed) return typed;
    if (fallback !== undefined) return fallback;
    throw new Error(`${question} is needed.`);
  };
  const address = normaliseAddress(await answer(flags.address, "Server address (OpenAI-compatible, such as http://localhost:11434/v1)"));
  const modelId = (await answer(flags.modelId, "Model id on that server, such as qwen3.5:9b")).trim();
  if (!modelId || modelId.length > 200) throw new Error("The model id must be 1 to 200 characters.");
  const contextSize = wholeNumber(await answer(flags.contextSize, "Context size, in tokens"), "The context size", 1024, 10_000_000);
  const limit = wholeNumber(await answer(flags.limit, "Runs at once", String(defaultModelLimit)), "Runs at once", 1, 100);
  const timeoutMinutes = wholeNumber(
    await answer(flags.timeoutMinutes, "Time limit per Run, in minutes", String(defaultTimeoutMinutes)),
    "The time limit",
    1,
    24 * 60,
  );

  const model: MachineModel = { name, address, modelId, contextSize, limit, timeoutMinutes };
  if (flags.keyEnv !== undefined) {
    if (!envName.test(flags.keyEnv)) throw new Error(`${JSON.stringify(flags.keyEnv)} isn't an environment variable's name.`);
    model.keyEnv = flags.keyEnv;
  } else if (!flags.noKey) {
    const key = (await ask("Key (leave empty for none): ", { hidden: true })).trim();
    if (key) model.key = key;
  }

  // Try the server before saving, so one that can't do a Run is found now. The key is never printed.
  print(`Checking ${modelId} at ${address}…`);
  const failures = await checkModelWorks(model, keyOf(model, options.env ?? process.env), { ...options.check, note: print });
  if (failures.length > 0) {
    print(`${name} failed ${failures.length === 1 ? "a check" : "the checks"}:`);
    for (const failure of failures) print(`- ${failure.what}\n  ${failure.fix}`);
    let save = flags.saveAnyway === true;
    if (!save) {
      const typed = await ask("Save anyway? [y/N]: ").catch(() => "");
      save = /^y(es)?$/i.test(typed.trim());
    }
    if (!save) {
      print(`Didn't save ${name}. Add it again once the server is put right, or with --save-anyway.`);
      return 1;
    }
  } else {
    print("It calls tools and keeps its whole context.");
  }

  const config = await readConfig(options.configPath);
  const replacing = config.models.some((m) => m.name === name);
  await writeConfig(options.configPath, { ...config, models: [...config.models.filter((m) => m.name !== name), model] });
  print(
    `${replacing ? "Replaced" : "Added"} the Machine model ${name}. A running \`cronk-runner run\` offers it within about a minute.`,
  );
  return 0;
}

/** Lists the Machine models, each with whether its server answers now, never with its key. */
export async function listModels(options: ModelOptions): Promise<number> {
  const env = options.env ?? process.env;
  const { models } = await readConfig(options.configPath);
  if (models.length === 0) {
    options.print("No Machine models yet: add one with `cronk-runner model add <name>`.");
    return 0;
  }
  const ups = await Promise.all(models.map((model) => checkModel(model, env)));
  models.forEach((model, i) => {
    const key = model.keyEnv ? `key from $${model.keyEnv}` : model.key ? "key saved" : "no key";
    options.print(
      `${model.name}: ${ups[i] ? "up" : "down"}, ${model.modelId} at ${model.address}, context ${model.contextSize}, ` +
        `${model.limit} at once, time limit ${model.timeoutMinutes} min, ${key}`,
    );
  });
  return 0;
}

/** Removes a Machine model; a name that isn't set up is an error. */
export async function removeModel(name: string, options: ModelOptions): Promise<number> {
  const config = await readConfig(options.configPath);
  if (!config.models.some((m) => m.name === name)) {
    console.error(`No Machine model is called ${name}: \`cronk-runner model list\` shows them.`);
    return 1;
  }
  await writeConfig(options.configPath, { ...config, models: config.models.filter((m) => m.name !== name) });
  options.print(`Removed the Machine model ${name}. A running \`cronk-runner run\` stops offering it within about a minute.`);
  return 0;
}

/** The model's key: the one kept, or the environment variable's it names; none when it has neither. */
export function keyOf(model: MachineModel, env: NodeJS.ProcessEnv): string | undefined {
  if (model.keyEnv) return env[model.keyEnv] || undefined;
  return model.key || undefined;
}

/** Whether the model's server answers a light request (`GET <address>/models`) with success, within a few seconds. */
export async function checkModel(model: MachineModel, env: NodeJS.ProcessEnv, timeoutMs = checkTimeoutMs): Promise<boolean> {
  const key = keyOf(model, env);
  try {
    const response = await fetch(`${model.address}/models`, {
      headers: { accept: "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel().catch(() => {});
    return response.ok;
  } catch {
    return false;
  }
}

/** What the daemon announces to Cronk: whether it runs Claude, and its Machine models by name, limit and up. */
export interface Announcement {
  claude: boolean;
  models: { name: string; limit: number; up: boolean }[];
}

/**
 * Checks each model's server and makes the announcement: whether Claude Code is usable, and the models' names, limits
 * and whether each is up, nothing else. Without a usable OpenCode none of them is up, though each is still announced as
 * set up.
 */
export async function announcementOf(models: MachineModel[], env: NodeJS.ProcessEnv, programs: Programs): Promise<Announcement> {
  const ups = programs.openCode === "ok" ? await Promise.all(models.map((model) => checkModel(model, env))) : models.map(() => false);
  return {
    claude: programs.claude === "ok",
    models: models.map((model, i) => ({ name: model.name, limit: model.limit, up: ups[i]! })),
  };
}
