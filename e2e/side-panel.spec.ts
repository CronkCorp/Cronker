import type { Page } from "@playwright/test";
import { setUp, signIn } from "../test/harness/flows.js";
import type { StartedCronk } from "../test/harness/start-cronk.js";
import { expect, signInInBrowser, test } from "./fixtures.js";

/**
 * Opens a long Ticket whose side panel is taller than a short window: blocked by many Tickets, with Files,
 * and a description long enough that the main column scrolls far.
 */
async function openTallTicket(page: Page, cronk: StartedCronk, { blockers = 12 } = {}) {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const call = async (path: string, body: unknown) => (await cronk.request("POST", path, { cookie, body })).json();
  const project = await call(`/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const description = Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1} of what the Ticket asks for.`).join("\n\n");
  const ticket = await call(`/api/projects/${project.id}/tickets`, { title: "Rate-limit sign-in", description });
  for (let i = 1; i <= blockers; i++) {
    const blocker = await call(`/api/projects/${project.id}/tickets`, { title: `Blocker ${i}` });
    await call(`/api/tickets/${ticket.id}/relations`, { kind: "blockedBy", ticketId: blocker.id });
  }
  for (const name of ["trace.json", "proxy.log", "notes.txt"]) {
    await fetch(new URL(`/api/tickets/${ticket.id}/attachments?name=${name}`, cronk.url), {
      method: "POST",
      headers: { cookie, "content-type": "text/plain" },
      body: "x",
    });
  }
  await page.setViewportSize({ width: 1280, height: 600 });
  await signInInBrowser(page, cronk);
  await page.goto(`${cronk.url}/tickets/${ticket.id}`);
  await expect(page.getByRole("heading", { name: /Rate-limit sign-in/ })).toBeVisible();
  await expect(page.getByRole("region", { name: "Files" }).getByRole("listitem")).toHaveCount(3);
}

const pageScroll = (page: Page) => page.evaluate(() => window.scrollY);

test("a side panel taller than the window scrolls on its own to its Relations and Files, leaving the main column at the top", async ({
  page,
  cronk,
}) => {
  await openTallTicket(page, cronk);
  const panel = page.getByRole("complementary", { name: "Details" });
  const files = page.getByRole("region", { name: "Files" });
  await expect(files).not.toBeInViewport();

  await panel.hover();
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 400);
  await expect(page.getByRole("region", { name: "Relations" }).getByRole("link", { name: /Blocker 12/ })).toBeInViewport();
  await expect(files.getByRole("listitem").last()).toBeInViewport({ ratio: 1 });
  expect(await pageScroll(page)).toBe(0);
});

test("scrolling over the main column scrolls the page, and the side panel stays in view down to the window's foot", async ({
  page,
  cronk,
}) => {
  await openTallTicket(page, cronk);
  const panel = page.getByRole("complementary", { name: "Details" });

  await page.getByRole("region", { name: "Description" }).hover();
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, 400);
  await expect.poll(() => pageScroll(page)).toBeGreaterThan(1000);
  await expect(page.getByRole("button", { name: /^Status / })).toBeInViewport({ ratio: 1 });
  // Stuck to the top, it fills the window but for the gaps above and below it.
  await expect.poll(async () => (await panel.boundingBox())!.height).toBe(600 - 2 * 16);
});

test("a side panel that fits the window has no scrollbar, and scrolling over it scrolls the page as before", async ({ page, cronk }) => {
  await openTallTicket(page, cronk, { blockers: 1 });
  await page.setViewportSize({ width: 1280, height: 1000 });
  const panel = page.getByRole("complementary", { name: "Details" });
  await expect(panel.getByRole("region", { name: "Files" })).toBeInViewport({ ratio: 1 });
  expect(await panel.evaluate((aside: HTMLElement) => aside.scrollHeight - aside.clientHeight)).toBe(0);
  expect(await panel.evaluate((aside: HTMLElement) => aside.offsetWidth - aside.clientWidth)).toBe(0);

  await panel.hover();
  await page.mouse.wheel(0, 400);
  await expect.poll(() => pageScroll(page)).toBe(400);
});

test("below 900px the side panel sits above the main column at its full height, as before", async ({ page, cronk }) => {
  await openTallTicket(page, cronk);
  await page.setViewportSize({ width: 800, height: 600 });
  const panel = page.getByRole("complementary", { name: "Details" });
  const description = page.getByRole("region", { name: "Description" });
  await expect.poll(async () => (await panel.boundingBox())!.y < (await description.boundingBox())!.y).toBe(true);
  expect(await panel.evaluate((aside: HTMLElement) => aside.scrollHeight - aside.clientHeight)).toBe(0);
  expect((await panel.boundingBox())!.height).toBeGreaterThan(600);
});

test("a Picker opened low in a scrolled side panel shows all its options", async ({ page, cronk }) => {
  await openTallTicket(page, cronk);
  await page.getByRole("complementary", { name: "Details" }).hover();
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 400);
  await page.getByRole("button", { name: /^Relation / }).click();
  const options = page.getByRole("listbox", { name: "Relation" }).getByRole("option");
  await expect(options).toHaveCount(3);
  for (const option of await options.all()) await expect(option).toBeInViewport({ ratio: 1 });
});
