import type { Clock } from "./clock.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";

/** What every part of the app is built from. */
export interface Context {
  config: Config;
  db: Db;
  clock: Clock;
}
