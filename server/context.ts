import type { Clock } from "./clock.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { Live } from "./live/live.js";

/** What every part of the app is built from. */
export interface Context {
  config: Config;
  db: Db;
  clock: Clock;
  live: Live;
}
