import { defineConfig } from "@playwright/test";

// Each test starts its own Cronk through the test harness (see e2e/fixtures.ts);
// run `npm run build:web` first, as `npm run test:e2e` does.
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  reporter: process.env.CI ? "github" : "list",
  use: { trace: "off" },
});
