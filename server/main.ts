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

// Every minute: Runs nothing has named for their Workspace's lost-Run threshold become lost, and
// rate-limited Runners whose pause has passed resume their queues.
const everyMinute = setInterval(() => {
  cronk.checkForLostRuns().catch((error: unknown) => cronk.app.log.error(error));
  cronk.resumePausedRunners().catch((error: unknown) => cronk.app.log.error(error));
}, 60_000);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    clearInterval(everyMinute);
    void cronk.close().then(() => process.exit(0));
  });
}
