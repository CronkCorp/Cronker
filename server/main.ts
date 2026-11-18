import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ConfigError, loadConfig } from "./config.js";
import { createCronk } from "./cronk.js";

// The built web client is dist/web: beside the built server (dist/server), or under
// the repository root when the server runs from source.
const fromDist = import.meta.url.includes("/dist/server/");
const builtWeb = fileURLToPath(new URL(fromDist ? "../web/" : "../dist/web/", import.meta.url));
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

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void cronk.close().then(() => process.exit(0));
  });
}
