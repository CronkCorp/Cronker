import type { Page } from "@playwright/test";
import { setUp, signIn } from "../test/harness/flows.js";
import type { StartedCronk } from "../test/harness/start-cronk.js";
import { expect, signInInBrowser, test } from "./fixtures.js";

/** Projects created out of key order, one with a long name, so the dropdown's order and width are both put to the test. */
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
}

test("the scope dropdown lists the Workspace, then the Projects by key, and choosing one goes to its page", async ({ page, cronk }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await withProjects(page, cronk);
  await page.getByRole("navigation", { name: "Sidebar" }).getByRole("link", { name: "Decisions" }).click();
  await expect(page.getByRole("heading", { name: "Decisions", level: 1 })).toBeVisible();
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
  await expect(page).toHaveURL(/\/projects\/API\/decisions$/);

  await page.getByRole("button", { name: "Scope: API Server and its API" }).click();
  await expect(page.getByRole("menuitemradio", { name: /^API / })).toBeChecked();
  await page.getByRole("menuitemradio", { name: /^CRONK / }).click();
  await expect(page).toHaveURL(/\/projects\/CRONK\/decisions$/);

  // Each choice is an address, so Back and Forward move between them.
  await page.goBack();
  await expect(page).toHaveURL(/\/projects\/API\/decisions$/);
  await expect(page.getByRole("button", { name: "Scope: API Server and its API" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(workspacePage);
  await page.goForward();
  await expect(page).toHaveURL(/\/projects\/API\/decisions$/);
});

for (const kind of ["Documents", "Terms", "Decisions", "Artifacts"]) {
  test(`with many Projects the ${kind} page head stays on one line, and fits at phone width`, async ({ page, cronk }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await withProjects(page, cronk);
    await page.getByRole("navigation", { name: "Sidebar" }).getByRole("link", { name: kind }).click();
    await page.getByRole("button", { name: "Scope: Workspace" }).click();
    await page.getByRole("menuitemradio", { name: /^CRONK / }).click();
    const heading = page.getByRole("heading", { name: kind, level: 1 });
    const scope = page.getByRole("button", { name: /^Scope: CRONK / });
    await expect(scope).toBeVisible();

    // On a desktop window, the title and the scope dropdown share one line.
    const headBox = (await heading.boundingBox())!;
    const scopeBox = (await scope.boundingBox())!;
    expect(Math.abs(headBox.y + headBox.height / 2 - (scopeBox.y + scopeBox.height / 2)), "title and dropdown on one line").toBeLessThan(
      headBox.height / 2,
    );
    // The button keeps to one line of text, its long name cut short.
    expect(scopeBox.height).toBeLessThan(40);

    // At phone width nothing in the head runs off the page.
    await page.setViewportSize({ width: 375, height: 800 });
    await expect(scope).toBeVisible();
    expect((await scope.boundingBox())!.height).toBeLessThan(40);
    const right = await scope.evaluate((e) => e.getBoundingClientRect().right);
    expect(right).toBeLessThanOrEqual(375);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  });
}
