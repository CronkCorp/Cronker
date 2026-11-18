import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Writable } from "node:stream";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import pg from "pg";
import { buildApp } from "./app.js";
import { systemClock, type Clock } from "./clock.js";
import type { Config } from "./config.js";
import type { Context } from "./context.js";
import { createPool, droppedConnectionMessage, migrate, reportDroppedConnection } from "./db.js";
import { issueSetupCode } from "./identity/setup.js";
import { Live } from "./live/live.js";
import type { RunnerKind } from "./runs/runner.js";
import { checkForLostRuns, resumePausedRunners, runReports } from "./runs/runs.js";
import { subscriptionRunner } from "./runs/subscription.js";

export interface CronkOptions {
  config: Config;
  clock?: Clock;
  logStream?: Writable;
  /** Further kinds of Runner Users may set up, by name, beside the built-in `subscription`. */
  runnerKinds?: Record<string, RunnerKind>;
}

export interface Cronk {
  app: FastifyInstance;
  listen(): Promise<void>;
  /** Makes lost the Runs nothing has named for their Workspace's lost-Run threshold. */
  checkForLostRuns(): Promise<void>;
  /** Resumes the queues of rate-limited Runners whose pause has passed. */
  resumePausedRunners(): Promise<void>;
  close(): Promise<void>;
}

/** Migrates the database, issues a setup code if the installation is fresh, and builds the app. */
export async function createCronk({ config, clock = systemClock, logStream, runnerKinds = {} }: CronkOptions): Promise<Cronk> {
  // Until the app (and its logger) exists, which is while migrating, a dropped connection goes to stderr.
  let log: FastifyBaseLogger | undefined;
  const db = createPool(config.databaseUrl, (error) => {
    if (log) log.error({ err: error }, droppedConnectionMessage);
    else reportDroppedConnection(error);
  });
  try {
    await migrate(db);
    const context: Context = { config, db, clock, live: new Live(), runners: {} };
    const reports = runReports(context);
    context.runners.subscription = subscriptionRunner(context);
    for (const [kind, build] of Object.entries(runnerKinds)) context.runners[kind] = build(reports);
    const app = await buildApp(context, { logStream });
    log = app.log;
    endConnectionsOnClose(app);
    await issueSetupCode(db, app.log);
    return {
      app,
      async listen() {
        await app.listen({ host: config.host, port: config.port });
      },
      checkForLostRuns: () => checkForLostRuns(context),
      resumePausedRunners: () => resumePausedRunners(context),
      async close() {
        await app.close();
        await endPool(db);
      },
    };
  } catch (error) {
    await db.end();
    throw error;
  }
}

/**
 * Ends the pool and waits until each of its connections has closed. `end()` alone resolves once the pool has let
 * go of them, while they may still be closing, so whatever comes next (such as dropping the database) could cut
 * them off mid-close.
 */
async function endPool(db: pg.Pool): Promise<void> {
  let open = db.totalCount;
  const closed = new Promise<void>((resolve) => {
    if (open === 0) return resolve();
    db.on("remove", () => {
      if (--open === 0) resolve();
    });
  });
  await db.end();
  await closed;
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
