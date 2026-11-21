import { defineConfig } from "@playwright/test";

/**
 * Tests tagged @every-browser also run in Firefox and WebKit: dragging is where browsers differ (only Chromium scrolls
 * a dragged-over board by itself), so the board's drag and drop is checked in each.
 */
const everyBrowser = /@every-browser/;

// Each test starts its own Cronk through the test harness (see e2e/fixtures.ts);
// run `npm run build:web` first, as `npm run test:e2e` does.
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  reporter: process.env.CI ? "github" : "list",
  use: { trace: "off" },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" }, grep: everyBrowser },
    { name: "webkit", use: { browserName: "webkit" }, grep: everyBrowser },
  ],
});
