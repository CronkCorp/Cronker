import { call, CronkError, type MachineSelf } from "./api.js";
import { readConfig } from "./config.js";

export interface StatusOptions {
  configPath: string;
  print: (line: string) => void;
}

/** What the daemon learned from one paired Cronk: the Machine and its Runners, or why it couldn't ask. */
export type CronkStatus = { url: string; machine: MachineSelf } | { url: string; error: string };

/** Asks each paired Cronk which Runners the Machine serves there, and prints it. */
export async function status(options: StatusOptions): Promise<CronkStatus[]> {
  const { print } = options;
  const config = await readConfig(options.configPath);
  if (config.cronks.length === 0) {
    print("This Machine isn't paired with any Cronk yet: run `cronk-runner login <url>`.");
    return [];
  }
  print(`Runs at once on this Machine: at most ${config.limit}.`);
  const statuses: CronkStatus[] = [];
  for (const cronk of config.cronks) {
    try {
      const machine = await call<MachineSelf>(cronk.url, "GET", "/api/machine", { token: cronk.token });
      statuses.push({ url: cronk.url, machine });
      print(`${cronk.url}: paired as ${machine.name}${machine.owner.email ? ` for ${machine.owner.email}` : ""}`);
      if (machine.runners.length === 0) print("  serves no Runners");
      for (const runner of machine.runners) print(`  serves ${runner.name}`);
    } catch (error) {
      const message =
        error instanceof CronkError && error.code === "invalid_machine_token"
          ? `unpaired: run \`cronk-runner login ${cronk.url}\` again`
          : `can't reach it: ${(error as Error).message}`;
      statuses.push({ url: cronk.url, error: message });
      print(`${cronk.url}: ${message}`);
    }
  }
  return statuses;
}
