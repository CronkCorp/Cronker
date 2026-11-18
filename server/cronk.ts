import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { buildApp } from "./app.js";
import { systemClock, type Clock } from "./clock.js";
import type { Config } from "./config.js";
import { migrate } from "./db.js";
import { issueSetupCode } from "./identity/setup.js";
import { Live } from "./live/live.js";

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
    const app = await buildApp({ config, db, clock, live: new Live() }, { logStream });
    endConnectionsOnClose(app);
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
