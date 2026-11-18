import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ConfigError, loadConfig } from "./config.js";
import { createCronk } from "./cronk.js";

// The built web client sits next to the built server (dist/web beside dist/server).
const builtWebRoot = fileURLToPath(new URL("../web/", import.meta.url));
const devWebRoot = fileURLToPath(new URL("../dist/web/", import.meta.url));
const webRoot = [builtWebRoot, devWebRoot].find((dir) => existsSync(`${dir}index.html`));

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
