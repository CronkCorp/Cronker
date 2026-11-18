import type { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { buildApp } from "./app.js";
import { systemClock, type Clock } from "./clock.js";
import type { Config } from "./config.js";
import type { Context } from "./context.js";
import { migrate } from "./db.js";
import { issueSetupCode } from "./identity/setup.js";
import { Live } from "./live/live.js";
import type { RunnerKind } from "./runs/runner.js";
import { runReports } from "./runs/runs.js";

export interface CronkOptions {
  config: Config;
  clock?: Clock;
  logStream?: Writable;
  /** The kinds of Runner Users may set up, by name. */
  runnerKinds?: Record<string, RunnerKind>;
}

export interface Cronk {
  app: FastifyInstance;
  listen(): Promise<void>;
  close(): Promise<void>;
}

/** Migrates the database, issues a setup code if the installation is fresh, and builds the app. */
export async function createCronk({ config, clock = systemClock, logStream, runnerKinds = {} }: CronkOptions): Promise<Cronk> {
  const db = new pg.Pool({ connectionString: config.databaseUrl });
  try {
    await migrate(db);
    const context: Context = { config, db, clock, live: new Live(), runners: {} };
    const reports = runReports(context);
    for (const [kind, build] of Object.entries(runnerKinds)) context.runners[kind] = build(reports);
    const app = await buildApp(context, { logStream });
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
