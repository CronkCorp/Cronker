import { fileURLToPath } from "node:url";
import { test as base } from "@playwright/test";
import { startCronk, type StartedCronk } from "../test/harness/start-cronk.js";

const webRoot = fileURLToPath(new URL("../dist/web/", import.meta.url));

export const test = base.extend<{ cronk: StartedCronk }>({
  cronk: async ({}, use) => {
    const cronk = await startCronk({ webRoot });
    await use(cronk);
    await cronk.stop();
  },
});

export { expect } from "@playwright/test";
