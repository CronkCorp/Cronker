import { expect, test } from "./fixtures.js";

// The look itself is checked by screenshots in review (docs/ui.md); these check what a screenshot
// can't: that the faces come from Cronk itself, and that the page follows the system's light or dark setting.

test("the IBM Plex faces load from Cronk itself, never from another host", async ({ page, cronk }) => {
  const hosts = new Set<string>();
  const fonts: string[] = [];
  page.on("request", (request) => {
    hosts.add(new URL(request.url()).host);
    if (request.resourceType() === "font") fonts.push(request.url());
  });

  await page.goto(cronk.url);
  await expect(page.getByRole("heading", { name: "Set up Cronk" })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  expect([...hosts]).toEqual([new URL(cronk.url).host]);
  expect(fonts.length).toBeGreaterThan(0);
  const loaded = await page.evaluate(() =>
    [...document.fonts].filter((face) => face.status === "loaded").map((face) => face.family.replaceAll('"', "")),
  );
  expect(loaded).toContain("IBM Plex Sans");

  // The mono face, for Ticket keys, model labels and Markdown sources, is served the same way.
  const mono = await page.evaluate(async () => (await document.fonts.load('14px "IBM Plex Mono"')).length);
  expect(mono).toBeGreaterThan(0);
  expect([...hosts]).toEqual([new URL(cronk.url).host]);
});

for (const [colorScheme, ground] of [
  ["light", "rgb(243, 244, 241)"],
  ["dark", "rgb(18, 21, 19)"],
] as const) {
  test(`the page ground follows the system's ${colorScheme} setting`, async ({ page, cronk }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto(cronk.url);
    await expect(page.getByRole("heading", { name: "Set up Cronk" })).toBeVisible();
    await expect(page.locator("body")).toHaveCSS("background-color", ground);
  });
}
