import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
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
import { checkForLostRuns, runReports } from "./runs/runs.js";

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
  /** Makes lost the Runs nothing has named for their Workspace's lost-Run threshold. */
  checkForLostRuns(): Promise<void>;
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
    endConnectionsOnClose(app);
    await issueSetupCode(db, app.log);
    return {
      app,
      async listen() {
        await app.listen({ host: config.host, port: config.port });
      },
      checkForLostRuns: () => checkForLostRuns(context),
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

/**
 * Ends connections as the app closes. Node closes only the connections idle at that moment,
 * so without this one that has not sent a request yet (browsers open such connections ahead
 * of need) or whose response was still on its way would hold closing up until Node timed it
 * out, a minute or more later.
 */
function endConnectionsOnClose(app: FastifyInstance): void {
  const unused = new Set<Socket>();
  let closing = false;
  app.server.on("connection", (socket: Socket) => {
    if (closing) {
      socket.destroy();
      return;
    }
    unused.add(socket);
    socket.once("close", () => unused.delete(socket));
  });
  app.server.on("request", (request: IncomingMessage, response: ServerResponse) => {
    unused.delete(request.socket);
    response.once("finish", () => {
      if (closing) request.socket.destroySoon();
    });
  });
  app.addHook("preClose", async () => {
    closing = true;
    for (const socket of unused) socket.destroy();
  });
}
