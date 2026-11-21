import { existsSync } from "node:fs";
import { ConfigError, loadConfig } from "./config.js";
import { createCronk } from "./cronk.js";
import { repoPath } from "./paths.js";

const builtWeb = repoPath("dist/web/");
const webRoot = existsSync(`${builtWeb}index.html`) ? builtWeb : undefined;

let config;
try {
  config = loadConfig(process.env, { webRoot });
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(`Cronk can't start: ${error.message}`);
  process.exit(1);
}

const cronk = await createCronk({ config });
await cronk.listen();
cronk.app.log.info(`Cronk is at ${config.publicUrl.origin}`);

// On startup and every five minutes: GitHub redelivers the App's webhook deliveries that failed, such
// as while Cronk or its tunnel was down, and that Cronk hasn't applied.
const replayFailedDeliveries = () => cronk.replayFailedDeliveries().catch((error: unknown) => cronk.app.log.error(error));
void replayFailedDeliveries();
const everyFiveMinutes = setInterval(replayFailedDeliveries, 5 * 60_000);

// Every minute: Runs nothing has named for their Workspace's lost-Run threshold become lost,
// rate-limited Runners whose pause has passed resume their queues, and running Managed Agents sessions
// get fresh installation tokens for their Repositories before theirs expire (one pass at a time, since a
// pass waits on GitHub and Anthropic).
let rotatingTokens = false;
const everyMinute = setInterval(() => {
  cronk.checkForLostRuns().catch((error: unknown) => cronk.app.log.error(error));
  cronk.resumePausedRunners().catch((error: unknown) => cronk.app.log.error(error));
  if (rotatingTokens) return;
  rotatingTokens = true;
  cronk
    .rotateRepositoryTokens()
    .catch((error: unknown) => cronk.app.log.error(error))
    .finally(() => {
      rotatingTokens = false;
    });
}, 60_000);

// Every three minutes: the sessions of running Managed Agents Runs are read, and Runs whose sessions stopped without
// `finish` fail. One pass at a time, since a pass waits on Anthropic.
let pollingSessions = false;
const everyThreeMinutes = setInterval(() => {
  if (pollingSessions) return;
  pollingSessions = true;
  cronk
    .pollManagedAgentsSessions()
    .catch((error: unknown) => cronk.app.log.error(error))
    .finally(() => {
      pollingSessions = false;
    });
}, 3 * 60_000);

// Every five seconds: GitHub is asked whether the Pull Requests waiting on a mergeability check conflict. One pass at a
// time, since a pass waits on GitHub.
let checkingMergeability = false;
const everyFiveSeconds = setInterval(() => {
  if (checkingMergeability) return;
  checkingMergeability = true;
  cronk
    .checkMergeability()
    .catch((error: unknown) => cronk.app.log.error(error))
    .finally(() => {
      checkingMergeability = false;
    });
}, 5_000);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    clearInterval(everyFiveSeconds);
    clearInterval(everyMinute);
    clearInterval(everyThreeMinutes);
    clearInterval(everyFiveMinutes);
    void cronk.close().then(() => process.exit(0));
  });
}
