import { setUp, signIn } from "../test/harness/flows.js";
import type { Locator } from "@playwright/test";
import { expect, test } from "./fixtures.js";

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

test("a board whose Statuses don't fit scrolls sideways itself, its columns still readable, while the page stays put", async ({
  page,
  cronk,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const call = async (method: string, path: string, body?: unknown) => (await cronk.request(method, path, { cookie, body })).json();
  const project = await call("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id;
  // Three more Statuses than the default nine, before Done.
  for (const name of ["Design", "QA", "Staging"]) {
    await call("POST", `/api/projects/${project.id}/statuses`, { name, kind: "active", position: 7 });
  }
  // A busy card in a column with a Step: Priority, Labels, a long word in its title and an Assignee.
  const busy = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Export Terms as GLOSSARY.md and Decisions as docs/adr/" });
  await call("PATCH", `/api/tickets/${busy.id}`, {
    statusId: status("Code review"),
    priority: "urgent",
    labels: ["security", "documentation"],
    assigneeId: (await call("GET", "/api/me")).user.id,
  });

  await page.goto(cronk.url);
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: "CRONK Cronker" }).click();
  const board = page.getByRole("region", { name: "Board" });
  await expect(board.getByRole("region", { name: "Backlog", exact: true })).toBeVisible();

  // Every open column keeps a card's readable width; Done and Canceled stay collapsed to their dot and count.
  const open = ["Backlog", "Triage", "Ready", "Investigate", "Implement", "Code review", "In Review", "Design", "QA", "Staging"];
  for (const name of open) {
    const box = (await board.getByRole("region", { name, exact: true }).boundingBox())!;
    expect(box.width, `${name} keeps a readable width`).toBeGreaterThanOrEqual(240);
  }
  for (const name of ["Done", "Canceled"]) {
    const box = (await board.getByRole("region", { name, exact: true }).boundingBox())!;
    expect(box.width, `${name} stays collapsed`).toBeLessThan(60);
  }
  // Each open column's name, and its Step's model label, are shown whole rather than cut off.
  const models: Record<string, string> = { Triage: "haiku", Investigate: "sonnet", Implement: "opus", "Code review": "sonnet" };
  const whole = (shown: Locator) => shown.evaluate((e) => e.scrollWidth <= e.clientWidth);
  for (const name of open) {
    const column = board.getByRole("region", { name, exact: true });
    const head = column.getByRole("heading", { name });
    expect(await whole(head), `${name} is named in full`).toBe(true);
    const model = models[name];
    if (model) expect(await whole(column.getByText(model, { exact: true })), `${name}'s ${model} is shown in full`).toBe(true);
  }
  const card = board.getByRole("region", { name: "Code review", exact: true }).getByRole("link", { name: /^CRONK-1 / });
  expect(await whole(card), "the busy card fits its column").toBe(true);

  // The board scrolls sideways; the document does not, and the page head stays where it was.
  expect(await board.evaluate((e) => e.scrollWidth > e.clientWidth), "the board overflows").toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);
  const title = page.getByRole("heading", { name: "Cronker", level: 1 });
  const before = (await title.boundingBox())!.x;
  await board.evaluate((e) => (e.scrollLeft = e.scrollWidth));
  const canceled = board.getByRole("region", { name: "Canceled", exact: true });
  const end = (await canceled.boundingBox())!;
  expect(end.x + end.width, "the last column scrolls into the screen").toBeLessThanOrEqual(1280);
  expect((await title.boundingBox())!.x, "the page head stays put").toBe(before);
  expect(await page.evaluate(() => window.scrollX)).toBe(0);
});

test("dragging a card to the board's edge scrolls it, so the card reaches a column that starts off screen", async ({ page, cronk }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const call = async (method: string, path: string, body?: unknown) => (await cronk.request(method, path, { cookie, body })).json();
  const project = await call("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  for (const name of ["Design", "QA", "Staging"]) {
    await call("POST", `/api/projects/${project.id}/statuses`, { name, kind: "active", position: 7 });
  }
  await call("POST", `/api/projects/${project.id}/tickets`, { title: "Ship it" });

  await page.goto(cronk.url);
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: "CRONK Cronker" }).click();
  const board = page.getByRole("region", { name: "Board" });
  const lane = (name: string) => board.getByRole("region", { name, exact: true });
  const card = lane("Backlog").getByRole("link", { name: /CRONK-1 Ship it/ });
  await expect(card).toBeVisible();

  // Staging, the last open column, starts past the board's right edge.
  const edge = (await board.boundingBox())!;
  expect((await lane("Staging").boundingBox())!.x, "Staging starts off screen").toBeGreaterThan(edge.x + edge.width);

  // Pick the card up and hold it at the board's right edge until Staging comes into view, then drop it there.
  const from = (await card.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  const y = edge.y + 60;
  await page.mouse.move(edge.x + edge.width / 2, y, { steps: 5 });
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
