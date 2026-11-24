import { setUp } from "../test/harness/flows.js";
import { expect, signInInBrowser, test } from "./fixtures.js";

test("a local Runner is set up, a Machine's code approved onto it, listed and unpaired", async ({ page, cronk }) => {
  await setUp(cronk);
  await signInInBrowser(page, cronk);
  await page.goto(`${cronk.url}/runners`);

  const setup = page.getByRole("region", { name: "Set up a Runner" });
  await setup.getByLabel("Runner name").fill("Laptop");
  await setup.getByLabel("Kind").selectOption("local");
  await setup.getByRole("button", { name: "Set up a local Runner" }).click();
  await expect(page.getByRole("region", { name: "Laptop" })).toBeVisible();

  // The daemon asks for a code, as `cronk-runner login` does.
  const started = await cronk.request("POST", "/api/machines/pairings", { body: { name: "ada-laptop", os: "darwin", daemonVersion: "0.3.0" } });
  const { userCode } = await started.json();

  const machines = page.getByRole("region", { name: "Machines" });
  await expect(machines.getByText("No Machines paired yet.")).toBeVisible();
  await machines.getByLabel("Code").fill(userCode);
  await expect(machines.getByRole("checkbox", { name: "Laptop" })).toBeChecked();
  await machines.getByRole("button", { name: "Approve" }).click();

  await expect(machines.getByRole("status")).toHaveText("Paired ada-laptop. Its daemon receives its token on its next poll.");
  const row = machines.getByRole("row").filter({ hasText: "ada-laptop" });
  await expect(row).toContainText("darwin");
  await expect(row).toContainText("0.3.0");
  await expect(row).toContainText("Laptop");
  await expect(row).toContainText("Never");

  await row.getByRole("button", { name: "Unpair" }).click();
  await page.getByRole("dialog", { name: "Unpair ada-laptop?" }).getByRole("button", { name: "Unpair" }).click();
  await expect(machines.getByText("No Machines paired yet.")).toBeVisible();
});

test("approving a code that expired or was mistyped says so", async ({ page, cronk }) => {
  await setUp(cronk);
  await signInInBrowser(page, cronk);
  await page.goto(`${cronk.url}/runners`);
  const setup = page.getByRole("region", { name: "Set up a Runner" });
  await setup.getByLabel("Runner name").fill("Laptop");
  await setup.getByLabel("Kind").selectOption("local");
  await setup.getByRole("button", { name: "Set up a local Runner" }).click();

  const machines = page.getByRole("region", { name: "Machines" });
  await machines.getByLabel("Code").fill("BCDF-GHJK");
  await machines.getByRole("button", { name: "Approve" }).click();

  await expect(machines.getByText(/No Machine is waiting with that code/)).toBeVisible();
});

test("a local Runner's allowed tools are edited on its card, kept on reload and reset to the default", async ({ page, cronk }) => {
  await setUp(cronk);
  await signInInBrowser(page, cronk);
  await page.goto(`${cronk.url}/runners`);
  const setup = page.getByRole("region", { name: "Set up a Runner" });
  await setup.getByLabel("Runner name").fill("Laptop");
  await setup.getByLabel("Kind").selectOption("local");
  await setup.getByRole("button", { name: "Set up a local Runner" }).click();

  const card = page.getByRole("region", { name: "Laptop" });
  const rules = card.getByRole("textbox", { name: "Allowed tools" });
  await expect(rules).toHaveValue(/^Bash\(git:\*\)\n/);
  await expect(rules).toHaveValue(/\nmcp__cronk$/);

  await rules.fill("Bash(git:*)\n\n  Bash(cargo test:*)  \n");
  await card.getByRole("button", { name: "Save allowed tools" }).click();
  await expect(card.getByText("Saved.")).toBeVisible();
  await expect(rules).toHaveValue("Bash(git:*)\nBash(cargo test:*)");

  await page.reload();
  await expect(rules).toHaveValue("Bash(git:*)\nBash(cargo test:*)");

  await card.getByRole("button", { name: "Reset to default" }).click();
  await expect(rules).toHaveValue(/^Bash\(git:\*\)\nBash\(npm:\*\)\n/);
});
