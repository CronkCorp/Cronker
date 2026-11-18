import type { Page } from "@playwright/test";
import type { StartedCronk } from "../test/harness/start-cronk.js";
import { expect, test } from "./fixtures.js";

async function setUpAndSignIn(page: Page, cronk: StartedCronk) {
  await cronk.request("POST", "/api/setup", {
    body: {
      setupCode: cronk.setupCode(),
      email: "ada@example.com",
      password: "correct horse battery",
      workspaceName: "Ada's Workspace",
    },
  });
  await page.goto(cronk.url);
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Ada's Workspace" })).toBeVisible();
}

test("create a second Workspace and switch between them", async ({ page, cronk }) => {
  await setUpAndSignIn(page, cronk);

  await page.getByRole("link", { name: "New Workspace" }).click();
  await page.getByLabel("Workspace name").fill("Friends");
  await page.getByRole("button", { name: "Create Workspace" }).click();
  await expect(page.getByRole("heading", { name: "Friends" })).toBeVisible();

  await page.getByLabel("Workspace", { exact: true }).selectOption({ label: "Ada's Workspace" });
  await expect(page.getByRole("heading", { name: "Ada's Workspace" })).toBeVisible();

  await page.getByLabel("Workspace", { exact: true }).selectOption({ label: "Friends" });
  await expect(page.getByRole("heading", { name: "Friends" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Friends" })).toBeVisible();

  // A Project of the second Workspace shows under that Workspace, even after a reload.
  await page.getByLabel("Project name").fill("Party");
  await page.getByLabel("Key").fill("PARTY");
  await page.getByRole("button", { name: "Create Project" }).click();
  await expect(page.getByRole("heading", { name: "Party" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Party" })).toBeVisible();
  await expect(page.getByLabel("Workspace", { exact: true })).toHaveValue(/.+/);
  await expect(page.getByRole("banner").getByRole("link", { name: "Friends" })).toBeVisible();
});

test("an Admin adds a User by email, who joins through the link", async ({ page, cronk, browser }) => {
  await setUpAndSignIn(page, cronk);

  await page.getByRole("link", { name: "Members" }).click();
  await page.getByLabel("Email").fill("bea@example.com");
  await page.getByRole("button", { name: "Add by email" }).click();
  const link = await page.getByLabel("Link for bea@example.com").inputValue();
  expect(link).toContain("/link#cronk_join_");
  await expect(page.getByRole("row", { name: /bea@example\.com/ })).toHaveCount(0);

  const bea = await (await browser.newContext()).newPage();
  await bea.goto(link);
  await expect(bea.getByRole("heading", { name: "Join Ada's Workspace" })).toBeVisible();
  await bea.getByLabel("Choose a password").fill("bea's long password");
  await bea.getByRole("button", { name: "Join" }).click();
  await expect(bea.getByRole("heading", { name: "Sign in to Cronk" })).toBeVisible();
  await bea.getByLabel("Email").fill("bea@example.com");
  await bea.getByLabel("Password").fill("bea's long password");
  await bea.getByRole("button", { name: "Sign in" }).click();
  await expect(bea.getByRole("heading", { name: "Ada's Workspace" })).toBeVisible();

  await page.reload();
  const row = page.getByRole("row", { name: /bea@example\.com/ });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Make Admin" }).click();
  await expect(row.getByRole("button", { name: "Remove Admin" })).toBeVisible();
  await row.getByRole("button", { name: "Remove from Workspace" }).click();
  await expect(row).toHaveCount(0);
});
