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

// docs/ui.md: buttons size to their label and are never full width outside sign-in forms.
test("only the sign-in form's buttons span their card; other signed-out pages' buttons fit their label", async ({ page, cronk }) => {
  const width = async (locator: ReturnType<typeof page.getByRole>) => (await locator.boundingBox())!.width;

  await page.goto(cronk.url);
  const setupField = await width(page.getByLabel("Setup code"));
  expect(await width(page.getByRole("button", { name: "Set up" }))).toBeLessThan(setupField / 2);

  const setup = await cronk.request("POST", "/api/setup", {
    body: { setupCode: cronk.setupCode(), email: "ada@example.com", password: "correct horse battery", workspaceName: "Ada's Workspace" },
  });
  const { workspace } = await setup.json();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Sign in to Cronk" })).toBeVisible();
  expect(await width(page.getByRole("button", { name: "Sign in" }))).toBe(await width(page.getByLabel("Email")));

  const signedIn = await cronk.request("POST", "/api/sign-in", { body: { email: "ada@example.com", password: "correct horse battery" } });
  const cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
  const added = await cronk.request("POST", `/api/workspaces/${workspace.id}/members`, { cookie, body: { email: "bea@example.com" } });
  const { link } = await added.json();
  await page.goto(link.url);
  await expect(page.getByRole("heading", { name: "Join Ada's Workspace" })).toBeVisible();
  expect(await width(page.getByRole("button", { name: "Join" }))).toBeLessThan((await width(page.getByLabel("Choose a password"))) / 2);
});
