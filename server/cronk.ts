import type { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { buildApp } from "./app.js";
import { systemClock, type Clock } from "./clock.js";
import type { Config } from "./config.js";
import { migrate } from "./db.js";
import { issueSetupCode } from "./identity/setup.js";
import { createLive } from "./live/live.js";

export interface CronkOptions {
  config: Config;
  clock?: Clock;
  logStream?: Writable;
}

export interface Cronk {
  app: FastifyInstance;
  listen(): Promise<void>;
  close(): Promise<void>;
}

/** Migrates the database, issues a setup code if the installation is fresh, and builds the app. */
export async function createCronk({ config, clock = systemClock, logStream }: CronkOptions): Promise<Cronk> {
  const db = new pg.Pool({ connectionString: config.databaseUrl });
  try {
    await migrate(db);
    const app = await buildApp({ config, db, clock, live: createLive() }, { logStream });
    await issueSetupCode(db, app.log);
    return {
      app,
      async listen() {
        await app.listen({ host: config.host, port: config.port });
      },
      async close() {
        await app.close();
        await db.end();
      },
    };
  } catch (error) {
    await db.end();
    throw error;
  }
}
