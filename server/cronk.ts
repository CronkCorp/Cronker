import type { IncomingMessage, ServerResponse } from "node:http";
import type { LookupFunction, Socket } from "node:net";
import type { Writable } from "node:stream";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import pg from "pg";
import { directoryStorage } from "./attachments/storage.js";
import { buildApp } from "./app.js";
import { systemClock, type Clock } from "./clock.js";
import type { Config } from "./config.js";
import type { Context } from "./context.js";
import { createPool, droppedConnectionMessage, migrate, reportDroppedConnection } from "./db.js";
import { backfillMentions } from "./work/mentions.js";
import { issueSetupCode } from "./identity/setup.js";
import { InstallationListings, InstallationTokens } from "./github/installations.js";
import { GitHubStatus } from "./github/status.js";
import { replayFailedDeliveries } from "./github/webhooks.js";
import { Jobs } from "./jobs.js";
import { runImports } from "./github/importing.js";
import { Live } from "./live/live.js";
import { forgetConnections } from "./machines/machines.js";
import { checkMergeability } from "./pipeline/conflicts.js";
import { queuePass } from "./pipeline/merge-queue.js";
import type { RunnerKind } from "./runs/runner.js";
import { checkForLostRuns, resumePausedRunners, runReports } from "./runs/runs.js";
import { managedAgentsRunner, pollManagedAgentsSessions, rotateRepositoryTokens } from "./runs/managed-agents.js";
import { subscriptionRunner } from "./runs/subscription.js";
import { localRunner } from "./runs/local.js";
import { InboxNotifier } from "./webhooks/notifier.js";
import { deliverWebhooks } from "./webhooks/webhooks.js";

export interface CronkOptions {
  config: Config;
  clock?: Clock;
  logStream?: Writable;
  /** Further kinds of Runner Users may set up, by name, beside the built-in `subscription`, `managed_agents` and `local`. */
  runnerKinds?: Record<string, RunnerKind>;
  /** Stops migrating short of this migration and those after it; only a test of that migration sets it. */
  migrateBefore?: string;
  /** Resolves host names Users give, such as webhooks'; the system's resolver when left out. */
  resolver?: LookupFunction;
}

export interface Cronk {
  app: FastifyInstance;
  listen(): Promise<void>;
  /** Makes lost the Runs nothing has named for their Workspace's lost-Run threshold. */
  checkForLostRuns(): Promise<void>;
  /** Reads the sessions of running Managed Agents Runs, ending the Runs whose sessions stopped. */
  pollManagedAgentsSessions(): Promise<void>;
  /** Sets fresh installation tokens on the Repositories of running Managed Agents sessions whose tokens expire soon. */
  rotateRepositoryTokens(): Promise<void>;
  /** Resumes the queues of rate-limited Runners whose pause has passed. */
  resumePausedRunners(): Promise<void>;
  /** Has GitHub redeliver the App's failed webhook deliveries Cronk hasn't applied. */
  replayFailedDeliveries(): Promise<void>;
  /** Asks GitHub whether the Pull Requests waiting on a mergeability check conflict, marking conflicting ones. */
  checkMergeability(): Promise<void>;
  /** Resolves once the work done after changes committed, such as indexing texts again after a Term's save, is done. */
  jobsSettled(): Promise<void>;
  /** Advances the Merge Queue: merges each queue's head that is clean and green, one per queue. */
  checkQueue(): Promise<void>;
  /** Reads the next page of issues of each running import of a Repository's GitHub issues. */
  runImports(): Promise<void>;
  /** Sends the webhook deliveries that are due, once the Inbox items queued so far have their deliveries. */
  deliverWebhooks(): Promise<void>;
  close(): Promise<void>;
}

/** Migrates the database, issues a setup code if the installation is fresh, and builds the app. */
export async function createCronk({
  config,
  clock = systemClock,
  logStream,
  runnerKinds = {},
  migrateBefore,
  resolver,
}: CronkOptions): Promise<Cronk> {
  // Until the app (and its logger) exists, which is while migrating, a dropped connection goes to stderr.
  let log: FastifyBaseLogger | undefined;
  const db = createPool(config.databaseUrl, (error) => {
    if (log) log.error({ err: error }, droppedConnectionMessage);
    else reportDroppedConnection(error);
  });
  try {
    await migrate(db, { before: migrateBefore });
    await backfillMentions(db);
    // A database migrated only partway, as a test of one migration has it, may have no Machines yet.
    if (!migrateBefore) await forgetConnections(db, clock.now());
    const context: Context = {
      config,
      db,
      clock,
      live: new Live(),
      runners: {},
      installationTokens: new InstallationTokens(clock),
      installationListings: new InstallationListings(clock),
      githubStatus: new GitHubStatus(),
      attachments: directoryStorage(config.attachments.directory),
      jobs: new Jobs(),
      resolver,
    };
    const reports = runReports(context);
    context.runners.subscription = subscriptionRunner(context);
    context.runners.managed_agents = managedAgentsRunner(context, reports);
    context.runners.local = localRunner(context);
    for (const [kind, build] of Object.entries(runnerKinds)) context.runners[kind] = build(reports);
    const app = await buildApp(context, { logStream });
    log = app.log;
    context.jobs.onError = (error, key) => app.log.error({ err: error, job: key }, "A job after a change failed.");
    context.githubStatus.onChange = (change) =>
      change.kind === "unavailable"
        ? app.log.warn({ until: change.until, reason: change.reason }, "GitHub is unavailable; Cronk waits before asking it again.")
        : app.log.info("GitHub is available again.");
    endConnectionsOnClose(app);
    await issueSetupCode(db, app.log);
    const notifier = new InboxNotifier(context, (error) => app.log.error(error));
    // A database migrated only partway, as a test of one migration has it, may have no webhooks yet.
    if (!migrateBefore) await notifier.start();
    return {
      app,
      async listen() {
        await app.listen({ host: config.host, port: config.port });
      },
      checkForLostRuns: () => checkForLostRuns(context),
      pollManagedAgentsSessions: () => pollManagedAgentsSessions(context, reports),
      rotateRepositoryTokens: () => rotateRepositoryTokens(context),
      resumePausedRunners: () => resumePausedRunners(context),
      replayFailedDeliveries: () => replayFailedDeliveries(context),
      checkMergeability: () => checkMergeability(context),
      jobsSettled: () => context.jobs.settled(),
      checkQueue: () => queuePass(context),
      runImports: () => runImports(context),
      async deliverWebhooks() {
        await notifier.idle();
        await deliverWebhooks(context);
      },
      async close() {
        await app.close();
        await context.jobs.settled();
        await notifier.stop();
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
