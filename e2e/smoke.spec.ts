import { expect, test } from "./fixtures.js";

test("set up a fresh installation, sign in, see the empty Workspace and sign out", async ({ page, cronk }) => {
  await page.goto(cronk.url);

  await expect(page.getByRole("heading", { name: "Set up Cronk" })).toBeVisible();
  await page.getByLabel("Setup code").fill("cronk_setup_wrong");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByLabel("Workspace name").fill("Ada's Workspace");
  await page.getByRole("button", { name: "Set up" }).click();
  await expect(page.getByRole("alert")).toContainText("setup code is not right");

  await page.getByLabel("Setup code").fill(cronk.setupCode());
  await page.getByRole("button", { name: "Set up" }).click();

  await expect(page.getByRole("heading", { name: "Sign in to Cronk" })).toBeVisible();
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("heading", { name: "Ada's Workspace" })).toBeVisible();
  await expect(page.getByText("No Projects yet.")).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Ada's Workspace" })).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Cronk" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Sign in to Cronk" })).toBeVisible();
});
