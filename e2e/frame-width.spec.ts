import { setUp, signIn } from "../test/harness/flows.js";
import type { Locator, Page } from "@playwright/test";
import type { StartedCronk } from "../test/harness/start-cronk.js";
import { expect, signInInBrowser, test } from "./fixtures.js";

/** The default board's Statuses, in order; Done and Canceled start collapsed. */
const statuses = ["Backlog", "Triage", "Ready", "Investigate", "Implement", "Code review", "Merge", "In Review", "Done", "Canceled"];

/** Ada's Project with the default Statuses, on a window `width` wide; returns the Project's address. */
async function project(page: Page, cronk: StartedCronk, width: number) {
  await page.setViewportSize({ width, height: 900 });
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  await cronk.request("POST", `/api/workspaces/${workspace.id}/projects`, { cookie, body: { name: "Cronker", key: "CRONK" } });
  await signInInBrowser(page, cronk);
  await page.getByRole("link", { name: "CRONK Cronker" }).click();
  await expect(page.getByRole("region", { name: "Board" }).getByRole("region", { name: "Backlog", exact: true })).toBeVisible();
  return page.url();
}

test("on a wide window the board spans the whole main column and shows every Status without scrolling sideways", async ({ page, cronk }) => {
  // The default board's eight open columns at 240px, Done and Canceled at 36px and nine 8px gaps need 2064px:
  // 2328px beside the 232px sidebar and the main column's padding.
  const width = 2560;
  await project(page, cronk, width);
  if (process.env.CRONK_SHOTS) await page.screenshot({ path: `${process.env.CRONK_SHOTS}/board-wide.png` });
  const board = page.getByRole("region", { name: "Board" });
  const sidebar = (await page.getByRole("navigation", { name: "Sidebar" }).boundingBox())!;

  // Sidebar to right edge, less the main column's 16px padding on each side.
  const spans = (await board.boundingBox())!;
  expect(spans.x).toBeCloseTo(sidebar.x + sidebar.width + 16, 0);
  expect(spans.x + spans.width).toBeCloseTo(width - 16, 0);

  // Every Status is on screen, and the board has nothing to scroll.
  for (const name of statuses) {
    await expect(board.getByRole("region", { name, exact: true }), `${name} is on screen`).toBeInViewport({ ratio: 1 });
  }
  expect(await board.evaluate((e) => e.scrollWidth <= e.clientWidth), "the board doesn't scroll sideways").toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

  // The page head and filters line up with the board's left edge.
  expect((await page.getByRole("heading", { name: "Cronker", level: 1 }).boundingBox())!.x).toBeCloseTo(spans.x, 0);
  expect((await page.getByRole("group", { name: "Filters" }).boundingBox())!.x).toBeCloseTo(spans.x, 0);
});

test("the List view and other pages span the whole main column on a wide window too", async ({ page, cronk }) => {
  const width = 2560;
  const url = await project(page, cronk, width);
  const sidebar = (await page.getByRole("navigation", { name: "Sidebar" }).boundingBox())!;
  /** The page's title and its edge-to-edge content run from the sidebar to the window's edge, less 16px padding. */
  const spans = async (title: string, content: Locator) => {
    expect((await page.getByRole("heading", { name: title, level: 1 }).boundingBox())!.x, `${title}'s head starts by the sidebar`).toBeCloseTo(
      sidebar.x + sidebar.width + 16,
      0,
    );
    const box = (await content.boundingBox())!;
    expect(box.x + box.width, `${title} reaches the right edge`).toBeCloseTo(width - 16, 0);
  };

  await page.goto(`${url.replace(/\/$/, "")}/list`);
  await expect(page.getByRole("heading", { name: "Cronker", level: 1 })).toBeVisible();
  if (process.env.CRONK_SHOTS) await page.screenshot({ path: `${process.env.CRONK_SHOTS}/list-wide.png` });
  await spans("Cronker", page.locator(".page-head").first());

  await page.getByRole("link", { name: "Agents" }).click();
  await expect(page.getByRole("heading", { name: "Agents", level: 1 })).toBeVisible();
  await spans("Agents", page.locator(".page-head").first());
});
