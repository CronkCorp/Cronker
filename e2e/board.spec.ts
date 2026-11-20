import { setUp, signIn } from "../test/harness/flows.js";
import type { Locator, Page } from "@playwright/test";
import type { StartedCronk } from "../test/harness/start-cronk.js";
import { expect, signInInBrowser, test } from "./fixtures.js";

test("Done and Canceled board columns start collapsed to their dot and count, and open on click until the User leaves", async ({
  page,
  cronk,
}) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const call = async (method: string, path: string, body?: unknown) => (await cronk.request(method, path, { cookie, body })).json();
  const project = await call("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id;
  const finished = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Shipped" });
  await call("PATCH", `/api/tickets/${finished.id}`, { statusId: status("Done") });
  await call("POST", `/api/projects/${project.id}/tickets`, { title: "Still open" });

  await page.goto(cronk.url);
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: "CRONK Cronker" }).click();
  const board = page.getByRole("region", { name: "Board" });
  const lane = (name: string) => board.getByRole("region", { name, exact: true });
  await expect(lane("Backlog").getByRole("link", { name: /CRONK-2 Still open/ })).toBeVisible();

  const done = lane("Done").getByRole("button", { name: "Done, 1 Ticket" });
  await expect(done).toHaveAttribute("aria-expanded", "false");
  await expect(lane("Done").getByRole("link", { name: /CRONK-1 Shipped/ })).toBeHidden();
  await expect(lane("Canceled").getByRole("button", { name: "Canceled, 0 Tickets" })).toHaveAttribute("aria-expanded", "false");

  await done.click();
  await expect(done).toHaveAttribute("aria-expanded", "true");
  await expect(lane("Done").getByRole("link", { name: /CRONK-1 Shipped/ })).toBeVisible();

  // Nothing is stored: coming back, it starts collapsed again.
  await page.reload();
  await expect(lane("Done").getByRole("button", { name: "Done, 1 Ticket" })).toHaveAttribute("aria-expanded", "false");
  await expect(lane("Done").getByRole("link", { name: /CRONK-1 Shipped/ })).toBeHidden();
});

/** A Project named Cronker with thirteen Statuses, three more than the default board's, as Ada sees it at 1280px. */
async function crowdedBoard(page: Page, cronk: StartedCronk) {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const call = async (method: string, path: string, body?: unknown) => (await cronk.request(method, path, { cookie, body })).json();
  const project = await call("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  // Before Done, so they come after In Review.
  for (const name of ["Design", "Release", "Staging"]) {
    await call("POST", `/api/projects/${project.id}/statuses`, { name, kind: "active", position: 8 });
  }
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id;
  const open = async () => {
    await signInInBrowser(page, cronk);
    await page.getByRole("link", { name: "CRONK Cronker" }).click();
    const board = page.getByRole("region", { name: "Board" });
    await expect(board.getByRole("region", { name: "Backlog", exact: true })).toBeVisible();
    return { board, lane: (name: string) => board.getByRole("region", { name, exact: true }) };
  };
  return { call, project, status, open };
}

test("a board whose Statuses don't fit scrolls sideways itself, its columns still readable, while the page stays put", async ({
  page,
  cronk,
}) => {
  const { call, project, status, open } = await crowdedBoard(page, cronk);
  // A busy card in a column with a Step: Priority, Labels, a long word in its title and an Assignee.
  const busy = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Export Terms as GLOSSARY.md and Decisions as docs/adr/" });
  await call("PATCH", `/api/tickets/${busy.id}`, {
    statusId: status("Code review"),
    priority: "urgent",
    labels: ["security", "documentation"],
    assigneeId: (await call("GET", "/api/me")).user.id,
  });
  const { board, lane } = await open();

  // Every open column keeps a card's readable width; Done and Canceled stay collapsed to their dot and count.
  const columns = ["Backlog", "Triage", "Ready", "Investigate", "Implement", "Code review", "Merge", "In Review", "Design", "Release", "Staging"];
  for (const name of columns) {
    expect((await lane(name).boundingBox())!.width, `${name} keeps a readable width`).toBeGreaterThanOrEqual(240);
  }
  for (const name of ["Done", "Canceled"]) {
    expect((await lane(name).boundingBox())!.width, `${name} stays collapsed`).toBeLessThan(60);
  }
  // Each open column's name, and its Step's model label, are shown whole rather than cut off.
  const models: Record<string, string> = {
    Triage: "haiku",
    Investigate: "sonnet",
    Implement: "opus",
    "Code review": "sonnet",
    Merge: "haiku",
  };
  const whole = (shown: Locator) => shown.evaluate((e) => e.scrollWidth <= e.clientWidth);
  for (const name of columns) {
    expect(await whole(lane(name).getByRole("heading", { name })), `${name} is named in full`).toBe(true);
    const model = models[name];
    if (model) expect(await whole(lane(name).getByText(model, { exact: true })), `${name}'s ${model} is shown in full`).toBe(true);
  }
  const card = lane("Code review").getByRole("link", { name: /^CRONK-1 / });
  expect(await whole(card), "the busy card fits its column").toBe(true);

  // The board scrolls sideways; the document does not, and the page head stays where it was.
  expect(await board.evaluate((e) => e.scrollWidth > e.clientWidth), "the board overflows").toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);
  const title = page.getByRole("heading", { name: "Cronker", level: 1 });
  const before = (await title.boundingBox())!.x;
  await board.evaluate((e) => (e.scrollLeft = e.scrollWidth));
  const end = (await lane("Canceled").boundingBox())!;
  expect(end.x + end.width, "the last column scrolls into the screen").toBeLessThanOrEqual(1280);
  await expect(lane("Staging").getByRole("heading", { name: "Staging" })).toBeInViewport();
  expect((await title.boundingBox())!.x, "the page head stays put").toBe(before);
  expect(await page.evaluate(() => window.scrollX)).toBe(0);
});

test("dragging a card to the board's edge scrolls it, so the card reaches a column that starts off screen", async ({ page, cronk }) => {
  const { call, project, open } = await crowdedBoard(page, cronk);
  await call("POST", `/api/projects/${project.id}/tickets`, { title: "Ship it" });
  const { board, lane } = await open();
  const card = lane("Backlog").getByRole("link", { name: /CRONK-1 Ship it/ });

  // Staging, the last open column, starts past the board's right edge.
  const edge = (await board.boundingBox())!;
  expect((await lane("Staging").boundingBox())!.x, "Staging starts off screen").toBeGreaterThan(edge.x + edge.width);

  // Pick the card up and hold it at the board's right edge until Staging comes into view, then drop it there.
  const from = (await card.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  const y = edge.y + 60;
  await page.mouse.move(edge.x + edge.width / 2, y, { steps: 5 });
  expect(await board.evaluate((e) => e.scrollLeft), "the board has not scrolled before the card reaches its edge").toBe(0);
  await expect(async () => {
    await page.mouse.move(edge.x + edge.width - 8, y);
    await page.mouse.move(edge.x + edge.width - 4, y);
    const staging = (await lane("Staging").boundingBox())!;
    expect(staging.x + staging.width).toBeLessThanOrEqual(edge.x + edge.width);
  }).toPass({ timeout: 10_000 });
  const staging = (await lane("Staging").boundingBox())!;
  await page.mouse.move(staging.x + staging.width / 2, staging.y + 80, { steps: 5 });
  await page.mouse.up();

  await expect(lane("Staging").getByRole("link", { name: /CRONK-1 Ship it/ })).toBeVisible();
  await expect(lane("Backlog").getByRole("link", { name: /CRONK-1 Ship it/ })).toBeHidden();
  expect(await page.evaluate(() => window.scrollX)).toBe(0);
});

test("every board column, open or collapsed, is as tall as the tallest, and stays so as cards come and go live", async ({
  page,
  cronk,
}) => {
  const { call, project, status, open } = await crowdedBoard(page, cronk);
  const inImplement = async (title: string) => {
    const ticket = await call("POST", `/api/projects/${project.id}/tickets`, { title });
    await call("PATCH", `/api/tickets/${ticket.id}`, { statusId: status("Implement") });
    return ticket;
  };
  for (let i = 1; i <= 8; i++) await inImplement(`Busy ticket ${i}`);
  await call("POST", `/api/projects/${project.id}/tickets`, { title: "Lonely" });
  const { lane } = await open();
  await expect(lane("Implement").getByRole("link", { name: /Busy ticket 8/ })).toBeVisible();

  const names = [
    ...["Backlog", "Triage", "Ready", "Investigate", "Implement", "Code review", "Merge", "In Review"],
    ...["Design", "Release", "Staging", "Done", "Canceled"],
  ];
  const bottom = async (name: string) => {
    const box = (await lane(name).boundingBox())!;
    return Math.round(box.y + box.height);
  };
  const bottoms = () => Promise.all(names.map(bottom));
  const implementBottom = () => bottom("Implement");
  expect(await implementBottom(), "Implement outgrows the 60vh floor").toBeGreaterThan(page.viewportSize()!.height * 0.6 + 200);
  expect(new Set(await bottoms()).size, "every column ends at the same height").toBe(1);

  // Cards stay at the top of a short column rather than spreading over its extra height.
  const top = async (name: string, title: RegExp) => (await lane(name).getByRole("link", { name: title }).boundingBox())!.y;
  const first = await top("Implement", /Busy ticket 1$/);
  expect(await top("Backlog", /Lonely/), "Backlog's card sits at its top, level with Implement's first").toBe(first);

  // A live update adds two more cards: every column grows with Implement, without a reload.
  const short = await implementBottom();
  const ninth = await inImplement("Busy ticket 9");
  const tenth = await inImplement("Busy ticket 10");
  await expect(lane("Implement").getByRole("link", { name: /Busy ticket 10/ })).toBeVisible();
  expect(await implementBottom()).toBeGreaterThan(short);
  expect(new Set(await bottoms()).size, "every column still ends at the same height").toBe(1);

  // Live updates move both out to Done, still collapsed: every column shrinks back with Implement.
  await call("PATCH", `/api/tickets/${ninth.id}`, { statusId: status("Done") });
  await call("PATCH", `/api/tickets/${tenth.id}`, { statusId: status("Done") });
  await expect(lane("Implement").getByRole("link", { name: /Busy ticket 10/ })).toBeHidden();
  await expect.poll(implementBottom).toBe(short);
  expect(new Set(await bottoms()).size, "every column ends at the same height after cards leave").toBe(1);
});

test("a dragged card dropped on the empty lower part of a short column moves into that column", async ({ page, cronk }) => {
  const { call, project, status, open } = await crowdedBoard(page, cronk);
  await page.setViewportSize({ width: 1280, height: 1000 });
  for (let i = 1; i <= 12; i++) {
    const ticket = await call("POST", `/api/projects/${project.id}/tickets`, { title: `Busy ticket ${i}` });
    await call("PATCH", `/api/tickets/${ticket.id}`, { statusId: status("Ready") });
  }
  const { lane } = await open();
  const card = lane("Ready").getByRole("link", { name: /Busy ticket 1$/ });
  await expect(card).toBeVisible();

  // Backlog has no cards; the point to drop on is below its 60vh floor, in the part it stretches to.
  const backlog = (await lane("Backlog").boundingBox())!;
  const floor = (await lane("Backlog").evaluate((e) => e.getBoundingClientRect().top)) + 0.6 * 1000;
  const y = floor + 40;
  expect(y, "the drop point is inside the stretched Backlog").toBeLessThan(backlog.y + backlog.height);
  expect(y, "the drop point is on screen").toBeLessThan(1000);

  const from = (await card.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(backlog.x + backlog.width / 2, y, { steps: 5 });
  // The whole stretched column lights up as the target, not just the part above the floor.
  await expect(lane("Backlog")).toHaveClass(/column-target/);
  await page.mouse.up();

  await expect(lane("Backlog").getByRole("link", { name: /Busy ticket 1$/ })).toBeVisible();
  await expect(lane("Ready").getByRole("link", { name: /Busy ticket 1$/ })).toBeHidden();
});
