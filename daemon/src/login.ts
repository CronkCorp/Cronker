import { hostname, platform } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { call, CronkError, type PairedMachine, type StartedPairing } from "./api.js";
import { normaliseUrl, readConfig, withCronk, writeConfig } from "./config.js";
import { daemonVersion } from "./version.js";

export interface LoginOptions {
  configPath: string;
  /** Where the daemon tells its User what to do. */
  print: (line: string) => void;
  /** Waits between polls; a test steps through it. */
  sleep?: (ms: number) => Promise<void>;
  /** The Machine's name; its host name when left out. */
  name?: string;
  os?: string;
}

/**
 * Pairs the Machine with the Cronk at the address: asks for a pairing code, shows it with the link where the User
 * approves it, polls until they do and writes the Machine token to the config, beside any other Cronks'.
 */
export async function login(cronkUrl: string, options: LoginOptions): Promise<PairedMachine> {
  const { print, sleep = (ms) => delay(ms) } = options;
  const url = normaliseUrl(cronkUrl);
  const config = await readConfig(options.configPath);
  const started = await call<StartedPairing>(url, "POST", "/api/machines/pairings", {
    body: { name: options.name ?? hostname(), os: options.os ?? platform(), daemonVersion, limit: config.limit },
  });
  print(`To pair this Machine with ${url}, open ${started.verificationUrl}`);
  print(`and approve the code ${started.userCode}, picking the local Runners it serves.`);
  print(`The code works until ${new Date(started.expiresAt).toLocaleTimeString()}.`);
  for (;;) {
    await sleep(started.interval * 1000);
    let paired: PairedMachine;
    try {
      paired = await call<PairedMachine>(url, "POST", "/api/machines/pairings/poll", { body: { deviceCode: started.deviceCode } });
    } catch (error) {
      if (error instanceof CronkError && error.code === "pairing_pending") continue;
      throw error;
    }
    // Read again, so a config changed meanwhile, such as by another login, isn't lost.
    const current = await readConfig(options.configPath);
    await writeConfig(
      options.configPath,
      withCronk(current, { url, machineId: paired.machine.id, machineName: paired.machine.name, token: paired.machineToken }),
    );
    print(`Paired as ${paired.machine.name}. Its token is saved in ${options.configPath}.`);
    return paired;
  }
}
