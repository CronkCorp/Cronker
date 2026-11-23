import { setUp } from "../test/harness/flows.js";
import { expect, signInInBrowser, test } from "./fixtures.js";

test("the token dialog issues Read, Write and Full tokens, warning on Full, and the table shows each level", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  await signInInBrowser(page, cronk);
  const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  await cronk.request("POST", `/api/workspaces/${workspace.id}/agents`, { cookie, body: { name: "claude-max" } });

  await page.goto(`${cronk.url}/adas-workspace/agents`);
  await page.getByRole("link", { name: "claude-max" }).click();
  await page.getByRole("button", { name: "Manage tokens" }).click();
  const dialog = page.getByRole("dialog", { name: "Tokens of claude-max" });
  const access = dialog.getByLabel("Access");
  const warning = dialog.getByRole("note", { name: "Full token" });

  // Write is the default, with no warning.
  await expect(access.locator("option:checked")).toHaveText(/^Write/);
  await expect(warning).toHaveCount(0);
  await dialog.getByLabel("Token name").fill("cloud");
  await dialog.getByRole("button", { name: "Issue token" }).click();
  await expect(dialog.getByLabel("Token cloud")).toBeVisible();

  await dialog.getByLabel("Token name").fill("reader");
  await access.selectOption("read");
  await dialog.getByRole("button", { name: "Issue token" }).click();
  await expect(dialog.getByLabel("Token reader")).toBeVisible();

  await access.selectOption("full");
  await expect(warning).toBeVisible();
  await dialog.getByLabel("Token name").fill("laptop");
  await dialog.getByRole("button", { name: "Issue token" }).click();
  await expect(dialog.getByLabel("Token laptop")).toBeVisible();
  // Issuing sets the level back to Write.
  await expect(warning).toHaveCount(0);

  const rows = dialog.getByRole("row");
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: "cloud" })).toContainText("Write");
  await expect(rows.filter({ hasText: "reader" })).toContainText("Read");
  await expect(rows.filter({ hasText: "laptop" })).toContainText("Full");
});
