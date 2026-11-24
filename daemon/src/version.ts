import { readFileSync } from "node:fs";

/** The daemon's version, from its package.json. */
export const daemonVersion: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;
