import { setUp, signIn } from "../test/harness/flows.js";
import type { Locator, Page } from "@playwright/test";
import type { StartedCronk } from "../test/harness/start-cronk.js";
import { expect, signInInBrowser, test } from "./fixtures.js";

/**
 * A wide window. The default board's eight open columns at 240px, Done and Canceled at 36px and nine 8px gaps need
 * 2064px: 2328px beside the 232px sidebar and the main column's 16px padding on each side.
 */
const width = 2560;

/** The default board's Statuses, in order; Done and Canceled start collapsed. */
const statuses = ["Backlog", "Triage", "Ready", "Investigate", "Implement", "Code review", "Merge", "In Review", "Done", "Canceled"];

/** Ada's Project with the default Statuses, opened on its board in a wide window; returns the board's address. */
async function openWideBoard(page: Page, cronk: StartedCronk) {
  await page.setViewportSize({ width, height: 900 });
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  await cronk.request("POST", `/api/workspaces/${workspace.id}/projects`, { cookie, body: { name: "Cronker", key: "CRONK" } });
  await signInInBrowser(page, cronk);
  await page.getByRole("link", { name: "CRONK Cronker" }).click();
  await expect(page.getByRole("region", { name: "Board" }).getByRole("region", { name: "Backlog", exact: true })).toBeVisible();
  return page.url();
}

/** Where the main column's content starts and ends: from the sidebar to the window's edge, less 16px padding each side. */
async function mainColumn(page: Page) {
  const sidebar = (await page.getByRole("navigation", { name: "Sidebar" }).boundingBox())!;
  return { left: sidebar.x + sidebar.width + 16, right: width - 16 };
}

const left = async (shown: Locator) => (await shown.boundingBox())!.x;
const right = async (shown: Locator) => {
  const box = (await shown.boundingBox())!;
  return box.x + box.width;
};

test("on a wide window the board spans the whole main column and shows every Status without scrolling sideways", async ({ page, cronk }) => {
  await openWideBoard(page, cronk);
  const board = page.getByRole("region", { name: "Board" });
  const column = await mainColumn(page);

  expect(await left(board)).toBeCloseTo(column.left, 0);
  expect(await right(board)).toBeCloseTo(column.right, 0);

  // Every Status is on screen, and the board has nothing to scroll.
  for (const name of statuses) {
    await expect(board.getByRole("region", { name, exact: true }), `${name} is on screen`).toBeInViewport({ ratio: 1 });
  }
  expect(await board.evaluate((e) => e.scrollWidth <= e.clientWidth), "the board doesn't scroll sideways").toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

  // The page head and filters line up with the board's left edge.
  expect(await left(page.getByRole("heading", { name: "Cronker", level: 1 }))).toBeCloseTo(column.left, 0);
  expect(await left(page.getByRole("group", { name: "Filters" }))).toBeCloseTo(column.left, 0);
});

test("the List view and other pages span the whole main column on a wide window too", async ({ page, cronk }) => {
  const board = await openWideBoard(page, cronk);
  const column = await mainColumn(page);

  await page.goto(`${board.replace(/\/$/, "")}/list`);
  const list = page.getByRole("region", { name: "List" });
  await expect(list.getByRole("region", { name: "Backlog", exact: true })).toBeVisible();
  expect(await left(list)).toBeCloseTo(column.left, 0);
  expect(await right(list)).toBeCloseTo(column.right, 0);

  // On Agents, the page head runs from its title by the sidebar to New Agent, last, at the right edge.
  await page.getByRole("link", { name: "Agents" }).click();
  const title = page.getByRole("heading", { name: "Agents", level: 1 });
  await expect(title).toBeVisible();
  expect(await left(title)).toBeCloseTo(column.left, 0);
  expect(await right(page.getByRole("button", { name: "New Agent" }))).toBeCloseTo(column.right, 0);
});
