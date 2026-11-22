import { setUp, signIn } from "../test/harness/flows.js";
import type { Locator, Page } from "@playwright/test";
import type { StartedCronk } from "../test/harness/start-cronk.js";
import { expect, signInInBrowser, test } from "./fixtures.js";

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

test("a card picked up by its title or key drags without selecting text, while a click on it still opens its Ticket and a middle-click a new tab", { tag: "@every-browser" }, async ({
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

  // A middle-click on the title opens the Ticket in a new tab and leaves the board where it is (Ctrl/Cmd+click selects
  // the card instead, see board-selection.spec.ts).
  if (browserName === "chromium") {
    const [opened] = await Promise.all([page.context().waitForEvent("page"), card("Triage").locator(".card-title").click({ button: "middle" })]);
    await opened.waitForLoadState();
    await expect(opened.getByRole("heading", { name: "CRONK-1 Ship it" })).toBeVisible();
    await opened.close();
    await expect(board).toBeVisible();
  }

  // A plain click on the title opens the Ticket.
  await card("Triage").locator(".card-title").click();
  await expect(page.getByRole("heading", { name: "CRONK-1 Ship it" })).toBeVisible();
});

test("a card drags from anywhere on it: its link's own box, its Labels, its avatars and the empty space beside its Blocked chip", { tag: "@every-browser" }, async ({
  page,
  cronk,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const call = async (method: string, path: string, body?: unknown) => (await cronk.request(method, path, { cookie, body })).json();
  const project = await call("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id;
  const blocker = await call("POST", `/api/projects/${project.id}/tickets`, { title: "First" });
  await call("PATCH", `/api/tickets/${blocker.id}`, { statusId: status("Ready") });
  const shipIt = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Ship it" });
  await call("PATCH", `/api/tickets/${shipIt.id}`, { labels: ["bug", "web"], assigneeId: (await call("GET", "/api/me")).user.id });
  await call("POST", `/api/tickets/${shipIt.id}/relations`, { kind: "blockedBy", ticketId: blocker.id });

  await signInInBrowser(page, cronk);
  await page.getByRole("link", { name: "CRONK Cronker" }).click();
  const board = page.getByRole("region", { name: "Board" });
  const lane = (name: string) => board.getByRole("region", { name, exact: true });
  const link = (name: string) => lane(name).getByRole("link", { name: /CRONK-2 Ship it/ });
  const card = (name: string) => lane(name).locator(".card").filter({ hasText: "Ship it" });
  await expect(link("Backlog")).toBeVisible();
  const selected = () => page.evaluate(() => window.getSelection()?.toString() ?? "");
  // Vivaldi and Opera, which Playwright can't run, select a link's text on a sideways drag unless the link says
  // draggable="true"; draggable="false" makes them select it always, user-select notwithstanding.
  await expect(link("Backlog"), "the card's link is explicitly draggable").toHaveAttribute("draggable", "true");

  /** Presses at a point of the card, moves to the middle of a column and lets go there. */
  const dragFrom = async (x: number, y: number, column: string) => {
    await page.mouse.move(x, y);
    await page.mouse.down();
    const to = (await lane(column).boundingBox())!;
    await page.mouse.move(to.x + to.width / 2, to.y + 200, { steps: 8 });
    await page.mouse.up();
    await expect(link(column), `the card dropped on ${column} is there`).toBeVisible();
    await expect.poll(async () => (await call("GET", `/api/tickets/${shipIt.id}`)).statusId).toBe(status(column));
    expect(await selected(), "no text is selected by the drag").toBe("");
  };

  // The link's own box, at its top right, where there is no text: its padding, beside the key.
  const ownBox = (await link("Backlog").boundingBox())!;
  await dragFrom(ownBox.x + ownBox.width - 6, ownBox.y + 4, "Triage");

  // A Label in the card's meta row.
  const label = (await card("Triage").locator(".card-meta .chip").first().boundingBox())!;
  await dragFrom(label.x + label.width / 2, label.y + label.height / 2, "Ready");

  // The Assignee's avatar at the meta row's right end.
  const avatar = (await card("Ready").locator(".card-meta .people").boundingBox())!;
  await dragFrom(avatar.x + avatar.width / 2, avatar.y + avatar.height / 2, "Investigate");

  // The card's own empty space, right of its Blocked chip and outside its link.
  const box = (await card("Investigate").boundingBox())!;
  const chip = (await card("Investigate").locator(".chip-blocked").boundingBox())!;
  await dragFrom(box.x + box.width - 10, chip.y + chip.height / 2, "Backlog");

  // A plain click on the link, away from its text, still opens the Ticket.
  const again = (await link("Backlog").boundingBox())!;
  await page.mouse.click(again.x + again.width - 6, again.y + 4);
  await expect(page.getByRole("heading", { name: "CRONK-2 Ship it" })).toBeVisible();
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
