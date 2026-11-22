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

test("dragging a card to the board's right or left edge scrolls it, so the card reaches a column that starts off screen", { tag: "@every-browser" }, async ({
  page,
  cronk,
}) => {
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

  // And back: held at the board's left edge, it scrolls back until Backlog is in view.
  const moved = (await lane("Staging").getByRole("link", { name: /CRONK-1 Ship it/ }).boundingBox())!;
  await page.mouse.move(moved.x + moved.width / 2, moved.y + moved.height / 2);
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2, y, { steps: 5 });
  await expect(async () => {
    await page.mouse.move(edge.x + 8, y);
    await page.mouse.move(edge.x + 4, y);
    expect((await lane("Backlog").boundingBox())!.x).toBeGreaterThanOrEqual(edge.x);
  }).toPass({ timeout: 10_000 });
  const backlog = (await lane("Backlog").boundingBox())!;
  await page.mouse.move(backlog.x + backlog.width / 2, backlog.y + 80, { steps: 5 });
  await page.mouse.up();

  await expect(lane("Backlog").getByRole("link", { name: /CRONK-1 Ship it/ })).toBeVisible();
  await expect(lane("Staging").getByRole("link", { name: /CRONK-1 Ship it/ })).toBeHidden();
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
  // Eight cards take Implement well past the 60vh floor (480px of the 800px window), more than a card's height beyond it.
  expect(await implementBottom(), "Implement outgrows the 60vh floor").toBeGreaterThan(page.viewportSize()!.height * 0.6 + 200);
  expect(new Set(await bottoms()).size, "every column ends at the same height").toBe(1);

  // Cards stay at the top of a short column rather than spreading over its extra height.
  const top = async (name: string, title: RegExp) => (await lane(name).getByRole("link", { name: title }).boundingBox())!.y;
  const first = await top("Implement", /Busy ticket 1$/);
  expect(await top("Backlog", /Lonely/), "Backlog's card sits at its top, level with Implement's first").toBe(first);

  // A live update adds two more cards: every column grows with Implement, without a reload.
  const eightCards = await implementBottom();
  const ninth = await inImplement("Busy ticket 9");
  const tenth = await inImplement("Busy ticket 10");
  await expect(lane("Implement").getByRole("link", { name: /Busy ticket 10/ })).toBeVisible();
  expect(await implementBottom()).toBeGreaterThan(eightCards);
  expect(new Set(await bottoms()).size, "every column still ends at the same height").toBe(1);

  // Live updates move both out to Done, still collapsed: every column shrinks back with Implement.
  await call("PATCH", `/api/tickets/${ninth.id}`, { statusId: status("Done") });
  await call("PATCH", `/api/tickets/${tenth.id}`, { statusId: status("Done") });
  await expect(lane("Implement").getByRole("link", { name: /Busy ticket 10/ })).toBeHidden();
  await expect.poll(implementBottom).toBe(eightCards);
  expect(new Set(await bottoms()).size, "every column ends at the same height after cards leave").toBe(1);
});

test("a dragged card dropped on the empty lower part of a short column moves into that column", async ({ page, cronk }) => {
  const { call, project, status, open } = await crowdedBoard(page, cronk);
  const windowHeight = 1000;
  await page.setViewportSize({ width: 1280, height: windowHeight });
  for (let i = 1; i <= 12; i++) {
    const ticket = await call("POST", `/api/projects/${project.id}/tickets`, { title: `Busy ticket ${i}` });
    await call("PATCH", `/api/tickets/${ticket.id}`, { statusId: status("Ready") });
  }
  const { lane } = await open();
  const card = lane("Ready").getByRole("link", { name: /Busy ticket 1$/ });
  await expect(card).toBeVisible();

  // Backlog has no cards; the point to drop on is below its 60vh floor, in the part it stretches to.
  const backlog = (await lane("Backlog").boundingBox())!;
  const floor = (await lane("Backlog").evaluate((e) => e.getBoundingClientRect().top)) + 0.6 * windowHeight;
  const y = floor + 40;
  expect(y, "the drop point is inside the stretched Backlog").toBeLessThan(backlog.y + backlog.height);
  expect(y, "the drop point is on screen").toBeLessThan(windowHeight);

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

/**
 * Drags a card with the mouse, as a User does, and drops it at the middle of a column, below its head. It picks the
 * card up by its title, the text a User most often presses on.
 */
async function dragCard(page: Page, card: Locator, column: Locator) {
  const from = (await card.locator(".card-title").boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  const to = (await column.boundingBox())!;
  await page.mouse.move(to.x + to.width / 2, to.y + 160, { steps: 8 });
  await page.mouse.up();
}

test("a card dragged onto another column moves its Ticket there, onto its own column does nothing, and a refused move says why above the board", { tag: "@every-browser" }, async ({
  page,
  cronk,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const call = async (method: string, path: string, body?: unknown) => (await cronk.request(method, path, { cookie, body })).json();
  const project = await call("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id;
  const shipIt = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Ship it" });

  // A Ticket a Run completed: Unverified in Done, it leaves only by Accept or Reopen.
  const shipped = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Shipped" });
  const runner = await call("POST", "/api/runners", { name: "Fake", kind: "fake" });
  const agent = await call("POST", `/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
  await call("PATCH", `/api/agents/${agent.id}`, { runnerId: runner.id });
  const { secret } = await call("POST", `/api/agents/${agent.id}/tokens`, { name: "cloud", access: "full" });
  await call("PATCH", `/api/tickets/${shipped.id}`, { delegateId: agent.id, autonomousDelegation: true, statusId: status("Code review") });
  const [run] = await call("GET", `/api/tickets/${shipped.id}/runs`);
  const finished = await cronk.request("POST", `/api/runs/${run.id}/finish`, {
    headers: { authorization: `Bearer ${secret}` },
    body: { outcome: "complete" },
  });
  expect(finished.status).toBe(200);
  expect((await call("GET", `/api/tickets/${shipped.id}`)).verification).toBe("unverified");

  const moves: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "PATCH" && request.url().includes("/api/tickets/")) moves.push(request.url());
  });
  await signInInBrowser(page, cronk);
  await page.getByRole("link", { name: "CRONK Cronker" }).click();
  const board = page.getByRole("region", { name: "Board" });
  const lane = (name: string) => board.getByRole("region", { name, exact: true });
  const shipItCard = (name: string) => lane(name).getByRole("link", { name: /CRONK-1 Ship it/ });
  await expect(shipItCard("Backlog")).toBeVisible();

  // Onto another column: the card shows up there without a reload, and the Ticket has moved.
  await dragCard(page, shipItCard("Backlog"), lane("Ready"));
  await expect(shipItCard("Ready")).toBeVisible();
  await expect(shipItCard("Backlog")).toBeHidden();
  expect((await call("GET", `/api/tickets/${shipIt.id}`)).statusId).toBe(status("Ready"));
  expect(moves).toHaveLength(1);

  // Onto its own column: nothing is asked of Cronk and the card stays.
  await dragCard(page, shipItCard("Ready"), lane("Ready"));
  await expect(shipItCard("Ready")).toBeVisible();
  expect(moves).toHaveLength(1);
  await expect(page.getByRole("alert")).toBeHidden();

  // A refused move: the reason shows above the board, and the card stays where it was.
  await board.evaluate((e) => (e.scrollLeft = e.scrollWidth));
  await lane("Done").getByRole("button", { name: "Done, 1 Ticket" }).click();
  await board.evaluate((e) => (e.scrollLeft = e.scrollWidth));
  const shippedCard = (name: string) => lane(name).getByRole("link", { name: /CRONK-2 Shipped/ });
  await dragCard(page, shippedCard("Done"), lane("In Review"));
  const refusal = page.getByRole("alert");
  await expect(refusal).toHaveText("CRONK-2 was completed by a Run and is Unverified: it leaves Done only by Accept or Reopen.");
  expect((await refusal.boundingBox())!.y, "the reason shows above the board").toBeLessThan((await board.boundingBox())!.y);
  await expect(shippedCard("Done")).toBeVisible();
  await expect(shippedCard("In Review")).toBeHidden();
});

test("a card picked up by its title or key drags without selecting text, while a click on it still opens its Ticket and a modified click a new tab", { tag: "@every-browser" }, async ({
  page,
  cronk,
  browserName,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const call = async (method: string, path: string, body?: unknown) => (await cronk.request(method, path, { cookie, body })).json();
  const project = await call("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id;
  const shipIt = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Ship it" });

  await signInInBrowser(page, cronk);
  await page.getByRole("link", { name: "CRONK Cronker" }).click();
  const board = page.getByRole("region", { name: "Board" });
  const lane = (name: string) => board.getByRole("region", { name, exact: true });
  const card = (name: string) => lane(name).getByRole("link", { name: /CRONK-1 Ship it/ });
  await expect(card("Backlog")).toBeVisible();
  const selected = () => page.evaluate(() => window.getSelection()?.toString() ?? "");

  // By its title: the Ticket moves, and none of the card's text is selected on the way.
  await dragCard(page, card("Backlog"), lane("Ready"));
  await expect(card("Ready")).toBeVisible();
  await expect(card("Backlog")).toBeHidden();
  await expect.poll(async () => (await call("GET", `/api/tickets/${shipIt.id}`)).statusId).toBe(status("Ready"));
  expect(await selected(), "no text is selected by the drag").toBe("");

  // By its key, at the card's top left.
  const key = (await card("Ready").locator(".card-key").boundingBox())!;
  await page.mouse.move(key.x + key.width / 2, key.y + key.height / 2);
  await page.mouse.down();
  const to = (await lane("Triage").boundingBox())!;
  await page.mouse.move(to.x + to.width / 2, to.y + 160, { steps: 8 });
  await page.mouse.up();
  await expect(card("Triage")).toBeVisible();
  expect(await selected(), "no text is selected by the drag").toBe("");

  // A Ctrl/Cmd+click on the title opens the Ticket in a new tab and leaves the board where it is.
  if (browserName === "chromium") {
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    const [opened] = await Promise.all([page.context().waitForEvent("page"), card("Triage").locator(".card-title").click({ modifiers: [modifier] })]);
    await opened.waitForLoadState();
    await expect(opened.getByRole("heading", { name: "CRONK-1 Ship it" })).toBeVisible();
    await opened.close();
    await expect(board).toBeVisible();
  }

  // A plain click on the title opens the Ticket.
  await card("Triage").locator(".card-title").click();
  await expect(page.getByRole("heading", { name: "CRONK-1 Ship it" })).toBeVisible();
});

test("Group Sub-Tickets folds them into their parent's card with a count, unfolds them there, and is remembered", async ({
  page,
  cronk,
}) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const call = async (method: string, path: string, body?: unknown) => (await cronk.request(method, path, { cookie, body })).json();
  const project = await call("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id;
  const parent = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Board view" });
  const sub = (title: string, parentId = parent.id) => call("POST", `/api/projects/${project.id}/tickets`, { title, parentId });
  const columns = await sub("Columns");
  const cards = await sub("Cards");
  await sub("Drag and drop");
  await sub("Card heights", cards.id);
  await call("PATCH", `/api/tickets/${columns.id}`, { statusId: status("Done") });

  await signInInBrowser(page, cronk);
  await page.getByRole("link", { name: "CRONK Cronker" }).click();
  const board = page.getByRole("region", { name: "Board" });
  const lane = (name: string) => board.getByRole("region", { name, exact: true });
  const backlog = lane("Backlog");
  const toggle = page.getByRole("button", { name: "Group Sub-Tickets" });

  // Off by default: every Sub-Ticket has its own card.
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(backlog.getByRole("link", { name: /^CRONK-3 Cards/ })).toBeVisible();
  await expect(backlog.getByRole("link", { name: /^CRONK-5 Card heights/ })).toBeVisible();
  await expect(lane("Done").getByRole("button", { name: "Done, 1 Ticket" })).toBeVisible();

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  // Folded, whatever their Status: only the parent keeps a card, counting its direct Sub-Tickets and the finished ones.
  await expect(backlog.getByRole("link")).toHaveCount(1);
  await expect(backlog.locator(".column-count")).toHaveText("1");
  await expect(lane("Done").getByRole("button", { name: "Done, 0 Tickets" })).toBeVisible();
  const count = backlog.getByRole("button", { name: "1 / 3 Sub-Tickets" });
  await expect(count).toHaveAttribute("aria-expanded", "false");

  await count.click();
  await expect(count).toHaveAttribute("aria-expanded", "true");
  const list = backlog.getByRole("list", { name: "Sub-Tickets" }).first();
  for (const name of ["CRONK-2 Columns", "CRONK-3 Cards", "CRONK-4 Drag and drop", "CRONK-5 Card heights"]) {
    await expect(list.getByRole("link", { name })).toBeVisible();
  }
  await list.getByRole("link", { name: "CRONK-3 Cards" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Cards");

  // Remembered on this browser, and the count follows live updates.
  await page.goBack();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await call("PATCH", `/api/tickets/${cards.id}`, { statusId: status("Done") });
  await expect(backlog.getByRole("button", { name: "2 / 3 Sub-Tickets" })).toBeVisible();
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(backlog.getByRole("link")).toHaveCount(1);

  // Off again: the board is as before.
  await toggle.click();
  await expect(backlog.getByRole("link", { name: /^CRONK-4 Drag and drop/ })).toBeVisible();
  await expect(backlog.getByRole("button", { name: /Sub-Tickets$/ })).toHaveCount(0);
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
});
