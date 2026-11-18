import { expect, test } from "./fixtures.js";

test("set up with a GitHub App, add someone by GitHub login, and they sign in with GitHub", async ({ page, browser, cronk }) => {
  cronk.github.signedInAs = cronk.github.account("ada-gh", "ada@example.com");
  const bea = cronk.github.account("bea", "bea@example.com");

  await page.goto(cronk.url);
  await page.getByLabel("Setup code").fill(cronk.setupCode());
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByLabel("Workspace name").fill("Ada's Workspace");
  await page.getByRole("button", { name: "Set up" }).click();

  await expect(page.getByRole("heading", { name: "Connect GitHub" })).toBeVisible();
  await page.getByRole("button", { name: "Create GitHub App" }).click();

  // The stand-in GitHub creates the App and sends the browser back.
  await expect(page.getByRole("status")).toContainText("The GitHub App is created");
  await expect(page.getByRole("link", { name: cronk.github.apps[0]!.name })).toBeVisible();

  await page.getByRole("link", { name: "Members" }).click();
  await page.getByLabel("GitHub login").fill("bea");
  await page.getByRole("button", { name: "Add by GitHub login" }).click();
  await expect(page.getByRole("status")).toContainText("@bea joins at their next sign-in with GitHub");

  // Bea, in her own browser, signs in with GitHub.
  const beaContext = await browser.newContext();
  const beaPage = await beaContext.newPage();
  cronk.github.signedInAs = bea;
  await beaPage.goto(cronk.url);
  await expect(beaPage.getByRole("heading", { name: "Sign in to Cronk" })).toBeVisible();
  await beaPage.getByRole("link", { name: "Sign in with GitHub" }).click();
  await expect(beaPage.getByRole("heading", { name: "Ada's Workspace" })).toBeVisible();
  await expect(beaPage.getByRole("link", { name: "bea@example.com" })).toBeVisible();

  // Someone nobody added is refused.
  await beaPage.getByRole("button", { name: "Sign out" }).click();
  cronk.github.signedInAs = cronk.github.account("mallory");
  await beaPage.getByRole("link", { name: "Sign in with GitHub" }).click();
  await expect(beaPage.getByRole("status")).toContainText("No User has that GitHub account");
  await beaContext.close();
});
