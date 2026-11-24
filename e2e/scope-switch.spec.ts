import type { Page } from "@playwright/test";
import { setUp, signIn } from "../test/harness/flows.js";
import type { StartedCronk } from "../test/harness/start-cronk.js";
import { expect, signInInBrowser, test } from "./fixtures.js";

/** Projects created out of key order, so the dropdown's order is put to the test. */
const projects = [
  { key: "WEB", name: "Web client" },
  { key: "API", name: "Server and its API" },
  { key: "CRONK", name: "Cronker, the simpler rewrite of Cronk with a rather long name" },
  { key: "DOCS", name: "Docs" },
  { key: "OPS", name: "Operations" },
  { key: "MOB", name: "Mobile" },
  { key: "DATA", name: "Data" },
  { key: "INFRA", name: "Infrastructure" },
];

async function withProjects(page: Page, cronk: StartedCronk) {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  for (const body of projects) await cronk.request("POST", `/api/workspaces/${workspace.id}/projects`, { cookie, body });
  await signInInBrowser(page, cronk);
  return workspace;
}

test("the scope dropdown lists the Workspace, then the Projects by key, and choosing one goes to its page", async ({ page, cronk }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const workspace = await withProjects(page, cronk);
  // The sidebar leads to the active Project's Terms; the Workspace's own page is kept for old links.
  await page.goto(`${cronk.url}/workspaces/${workspace.id}/glossary`);
  await expect(page.getByRole("heading", { name: "Terms", level: 1 })).toBeVisible();
  const workspacePage = page.url();

  await page.getByRole("button", { name: "Scope: Workspace" }).click();
  const scopes = page.getByRole("menuitemradio");
  await expect(scopes).toHaveText(["Workspace", ...projects.map((p) => `${p.key} ${p.name}`).sort()]);
  await expect(page.getByRole("menuitemradio", { name: "Workspace" })).toBeChecked();

  await page.keyboard.press("Escape");

  // From the keyboard: Enter opens the menu on its first item, ArrowDown moves on from Workspace, Enter chooses.
  await expect(page.getByRole("button", { name: "Scope: Workspace" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitemradio", { name: "Workspace" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitemradio", { name: /^API / })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/projects\/API\/glossary$/);

  await page.getByRole("button", { name: "Scope: API Server and its API" }).click();
  await expect(page.getByRole("menuitemradio", { name: /^API / })).toBeChecked();
  await page.getByRole("menuitemradio", { name: /^CRONK / }).click();
  await expect(page).toHaveURL(/\/projects\/CRONK\/glossary$/);

  // Each choice is an address, so Back and Forward move between them.
  await page.goBack();
  await expect(page).toHaveURL(/\/projects\/API\/glossary$/);
  await expect(page.getByRole("button", { name: "Scope: API Server and its API" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(workspacePage);
  await page.goForward();
  await expect(page).toHaveURL(/\/projects\/API\/glossary$/);
});

