import { createGitHubApp, setUp, signIn } from "../test/harness/flows.js";
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

test("Group Sub-Tickets folds them under their parent in their own column with a count, unfolds them there, and is remembered", async ({
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
  // Folded in their own column: the parent's card counts its direct Sub-Tickets there and the finished ones.
  await expect(backlog.getByRole("link")).toHaveCount(1);
  await expect(backlog.locator(".column-count")).toHaveText("1");
  const count = backlog.getByRole("button", { name: "0 / 2 Sub-Tickets" });
  await expect(count).toHaveAttribute("aria-expanded", "false");

  await count.click();
  await expect(count).toHaveAttribute("aria-expanded", "true");
  const list = backlog.getByRole("list", { name: "Sub-Tickets" }).first();
  for (const name of ["CRONK-3 Cards", "CRONK-4 Drag and drop", "CRONK-5 Card heights"]) {
    await expect(list.getByRole("link", { name })).toBeVisible();
  }
  await expect(list.getByRole("link", { name: "CRONK-2 Columns" })).toHaveCount(0);

  // A Sub-Ticket in another column than its parent stays in its own, folded into a copy of the parent's card there.
  const done = lane("Done");
  await done.getByRole("button", { name: "Done, 1 Ticket" }).click();
  await expect(done.getByRole("link")).toHaveCount(1);
  const copy = done.getByRole("link", { name: /^CRONK-1 Board view.*In Backlog/ });
  await expect(copy).toBeVisible();
  await expect(copy.locator("xpath=..")).not.toHaveAttribute("draggable", "true");
  // Easy to spot in both themes: its dashed edge and its text stand out from the column it sits in.
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    const contrast = await copyContrast(copy.locator("xpath=.."));
    expect(contrast.edge, `${colorScheme} edge`).toBeGreaterThanOrEqual(3);
    expect(contrast.title, `${colorScheme} title`).toBeGreaterThanOrEqual(4.5);
    expect(contrast.status, `${colorScheme} status`).toBeGreaterThanOrEqual(4.5);
  }
  await page.emulateMedia({ colorScheme: null });
  await done.getByRole("button", { name: "1 / 1 Sub-Ticket" }).click();
  await expect(done.getByRole("list", { name: "Sub-Tickets" }).getByRole("link", { name: "CRONK-2 Columns" })).toBeVisible();

  await list.getByRole("link", { name: "CRONK-3 Cards" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Cards");

  // Remembered on this browser, and the folding follows live updates: Cards moves to Done, under the copy there,
  // and its own Sub-Ticket, left in Backlog, folds into a copy of Cards' card in Backlog.
  await page.goBack();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await call("PATCH", `/api/tickets/${cards.id}`, { statusId: status("Done") });
  await expect(lane("Done").getByRole("button", { name: "Done, 1 Ticket" })).toBeVisible();
  await expect(backlog.getByRole("button", { name: "0 / 1 Sub-Ticket" })).toHaveCount(2);
  await expect(backlog.getByRole("link", { name: /^CRONK-3 Cards.*In Done/ })).toBeVisible();
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(backlog.getByRole("link")).toHaveCount(2);
  await lane("Done").getByRole("button", { name: "Done, 1 Ticket" }).click();
  await expect(lane("Done").getByRole("button", { name: "2 / 2 Sub-Tickets" })).toBeVisible();

  // Moved into its parent's column, a Sub-Ticket folds into the parent's own card, and the copy goes.
  await call("PATCH", `/api/tickets/${columns.id}`, { statusId: status("Backlog") });
  await call("PATCH", `/api/tickets/${cards.id}`, { statusId: status("Backlog") });
  await expect(backlog.getByRole("link")).toHaveCount(1);
  await expect(backlog.getByRole("button", { name: "0 / 3 Sub-Tickets" })).toBeVisible();
  await expect(lane("Done").getByRole("button", { name: "Done, 0 Tickets" })).toBeVisible();

  // Off again: the board is as before.
  await toggle.click();
  await expect(backlog.getByRole("link", { name: /^CRONK-4 Drag and drop/ })).toBeVisible();
  await expect(backlog.getByRole("button", { name: /Sub-Tickets$/ })).toHaveCount(0);
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
});

/** WCAG contrast of a card copy's dashed edge, title and status line against the column behind it. */
async function copyContrast(card: Locator) {
  return card.evaluate((element) => {
    const rgb = (color: string) => (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const luminance = (color: string) => {
      const [r = 0, g = 0, b = 0] = rgb(color).map((c) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a: string, b: string) => {
      const [x, y] = [luminance(a), luminance(b)];
      return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    };
    const column = getComputedStyle(element.closest(".column")!).backgroundColor;
    const color = (selector: string) => getComputedStyle(element.querySelector(selector)!).color;
    return {
      edge: ratio(getComputedStyle(element).borderTopColor, column),
      title: ratio(color(".card-title"), column),
      status: ratio(color(".card-copy-status"), column),
    };
  });
}

test("a merge making a Ticket's Pull Request conflict marks its In Review card and its Pull Requests live, and a clean answer clears them", async ({
  page,
  cronk,
}) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const call = async (method: string, path: string, body?: unknown) => (await cronk.request(method, path, { cookie, body })).json();
  await createGitHubApp(cronk, cookie);
  const app = cronk.github.apps[0]!;
  const installation = cronk.github.install(app, "cronkcorp", ["cronker"]);
  const cronker = installation.repositories[0]!;
  const project = await call("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  await call("POST", `/api/projects/${project.id}/repositories`, { id: cronker.id });
  const inReview = project.statuses.find((s: { name: string }) => s.name === "In Review").id;
  const ticket = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Make it so" });
  await call("PATCH", `/api/tickets/${ticket.id}`, { statusId: inReview });
  /** GitHub reports a Pull Request, as its webhook does. */
  const pullRequest = async (action: string, fields: Record<string, unknown>) => {
    const delivered = await cronk.github.deliver(app, "pull_request", {
      action,
      installation: { id: installation.id },
      repository: { id: cronker.id, full_name: cronker.fullName },
      pull_request: {
        state: "open", draft: false, merged: false, base: { ref: "main" }, updated_at: "2026-01-01T09:00:00Z", ...fields,
      },
    });
    expect(delivered.status).toBe(200);
  };
  const ours = { id: 501, number: 7, title: "CRONK-1: make it so", html_url: "https://github.com/cronkcorp/cronker/pull/7" };
  await pullRequest("opened", { ...ours, head: { ref: "cronk-1", sha: "c1" } });
  const other = { id: 609, number: 9, title: "Speed up the board", html_url: "https://github.com/cronkcorp/cronker/pull/9", head: { ref: "o", sha: "o1" } };
  await pullRequest("opened", other);
  await signInInBrowser(page, cronk);
  await page.getByRole("link", { name: "CRONK Cronker" }).click();
  const card = page.getByRole("region", { name: "Board" }).getByRole("region", { name: "In Review", exact: true }).getByRole("link", { name: /CRONK-1 Make it so/ });
  await expect(card).toBeVisible();
  await expect(card).not.toContainText("Conflicts with");

  // #9 merges as m1, and GitHub then says #7 conflicts with main.
  cronk.github.pullRequest(cronker, 7, { base: "main", baseSha: "m1", mergeable: false });
  await pullRequest("closed", { ...other, state: "closed", merged: true, merge_commit_sha: "m1", updated_at: "2026-01-01T09:30:00Z" });
  await cronk.checkMergeability();
  await expect(card).toContainText("Conflicts with main");

  await card.click();
  const panel = page.getByRole("region", { name: "Pull Requests" });
  await expect(panel).toContainText("Conflicts with main since cronkcorp/cronker#9");
  await expect(page.getByRole("region", { name: "Code to review" })).toContainText("Conflicts with main");

  // A push resolves it; GitHub then says it merges cleanly.
  cronk.github.pullRequest(cronker, 7, { headSha: "c2", base: "main", baseSha: "m1", mergeable: true });
  await pullRequest("synchronize", { ...ours, head: { ref: "cronk-1", sha: "c2" }, updated_at: "2026-01-01T09:40:00Z" });
  await cronk.checkMergeability();
  await expect(panel).not.toContainText("Conflicts with");
  await expect(page.getByRole("region", { name: "Code to review" })).not.toContainText("Conflicts with");
});

test("Merge queues Tickets: the Merge column lists them in queue order with their chips, live, and Remove from queue sends one back", async ({
  page,
  cronk,
}) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const call = async (method: string, path: string, body?: unknown) => (await cronk.request(method, path, { cookie, body })).json();
  await createGitHubApp(cronk, cookie);
  const app = cronk.github.apps[0]!;
  const installation = cronk.github.install(app, "cronkcorp", ["cronker"]);
  const cronker = installation.repositories[0]!;
  const project = await call("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  await call("POST", `/api/projects/${project.id}/repositories`, { id: cronker.id });
  const inReview = project.statuses.find((s: { name: string }) => s.name === "In Review").id;
  const deliver = async (event: string, payload: Record<string, unknown>) => {
    const delivered = await cronk.github.deliver(app, event, {
      installation: { id: installation.id },
      repository: { id: cronker.id, full_name: cronker.fullName },
      ...payload,
    });
    expect(delivered.status).toBe(200);
  };
  // CRONK-1 and CRONK-2 in In Review, each with an open Pull Request whose check passed and that GitHub says merges.
  for (const n of [1, 2]) {
    const ticket = await call("POST", `/api/projects/${project.id}/tickets`, { title: `Change ${n}` });
    await call("PATCH", `/api/tickets/${ticket.id}`, { statusId: inReview });
    await deliver("pull_request", {
      action: "opened",
      pull_request: {
        id: 500 + n, number: n, title: `CRONK-${n}: change ${n}`, state: "open", draft: false, merged: false,
        html_url: `https://github.com/cronkcorp/cronker/pull/${n}`, head: { ref: `cronk-${n}`, sha: `c${n}` }, base: { ref: "main" },
        updated_at: "2026-01-01T09:00:00Z",
      },
    });
    await deliver("check_run", {
      action: "completed",
      check_run: { id: n, name: "test", head_sha: `c${n}`, status: "completed", conclusion: "success", html_url: null },
    });
    cronk.github.pullRequest(cronker, n, { headSha: `c${n}`, mergeable: true });
  }
  await signInInBrowser(page, cronk);
  await page.getByRole("link", { name: "CRONK Cronker" }).click();
  const board = page.getByRole("region", { name: "Board" });
  const mergeColumn = board.getByRole("region", { name: "Merge", exact: true });

  // CRONK-2 is merged first from its page, then CRONK-1, so the queue's order isn't the keys'.
  for (const key of ["CRONK-2", "CRONK-1"]) {
    await board.getByRole("link", { name: new RegExp(key) }).click();
    const queue = page.getByRole("region", { name: "Merge Queue" });
    await queue.getByRole("button", { name: "Merge" }).click();
    await expect(queue).toContainText(key === "CRONK-2" ? "#1 in queue" : "#2 in queue");
    await page.goBack();
  }
  const cards = mergeColumn.locator(".card-link");
  await expect(cards).toHaveText([/CRONK-2.*#1 in queue/, /CRONK-1.*#2 in queue/]);

  // The queue pass merges CRONK-2; the board follows live, CRONK-1 moving up.
  await cronk.checkQueue();
  await expect(cards).toHaveText([/CRONK-1.*#1 in queue/]);

  // Remove from queue sends CRONK-1 back to In Review.
  await mergeColumn.getByRole("link", { name: /CRONK-1/ }).click();
  await page.getByRole("region", { name: "Merge Queue" }).getByRole("button", { name: "Remove from queue" }).click();
  await expect(page.getByRole("region", { name: "Merge Queue" }).getByRole("button", { name: "Merge" })).toBeVisible();
  await page.goBack();
  await expect(cards).toHaveCount(0);
  await expect(board.getByRole("region", { name: "In Review", exact: true })).toContainText("CRONK-1");
});

test("a Ticket with two queued Pull Requests stays in Merge after the first merges, its timeline saying so", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const call = async (method: string, path: string, body?: unknown) => (await cronk.request(method, path, { cookie, body })).json();
  await createGitHubApp(cronk, cookie);
  const app = cronk.github.apps[0]!;
  const installation = cronk.github.install(app, "cronkcorp", ["cronker", "website"]);
  const project = await call("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  for (const repository of installation.repositories) await call("POST", `/api/projects/${project.id}/repositories`, { id: repository.id });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id;
  const ticket = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Change both" });
  await call("PATCH", `/api/tickets/${ticket.id}`, { statusId: status("In Review") });
  // CRONK-1 has an open, green, mergeable Pull Request in each Repository.
  for (const [n, repository] of installation.repositories.entries()) {
    const deliver = async (event: string, payload: Record<string, unknown>) => {
      const delivered = await cronk.github.deliver(app, event, {
        installation: { id: installation.id },
        repository: { id: repository.id, full_name: repository.fullName },
        ...payload,
      });
      expect(delivered.status).toBe(200);
    };
    await deliver("pull_request", {
      action: "opened",
      pull_request: {
        id: 500 + n, number: n + 1, title: `CRONK-1: change ${repository.fullName}`, state: "open", draft: false, merged: false,
        html_url: `https://github.com/${repository.fullName}/pull/${n + 1}`, head: { ref: "cronk-1", sha: `c${n}` }, base: { ref: "main" },
        updated_at: "2026-01-01T09:00:00Z",
      },
    });
    await deliver("check_run", {
      action: "completed",
      check_run: { id: n + 1, name: "test", head_sha: `c${n}`, status: "completed", conclusion: "success", html_url: null },
    });
    cronk.github.pullRequest(repository, n + 1, { headSha: `c${n}`, mergeable: true });
  }
  // The website's Pull Request is held back, so only cronker's merges on the first pass.
  const website = cronk.github.pullRequest(installation.repositories[1]!, 2, { headSha: "c1", mergeable: null });
  await signInInBrowser(page, cronk);
  await page.getByRole("link", { name: "CRONK Cronker" }).click();
  await page.getByRole("region", { name: "Board" }).getByRole("link", { name: /CRONK-1/ }).click();
  const queue = page.getByRole("region", { name: "Merge Queue" });
  await queue.getByRole("button", { name: "Merge" }).click();
  await expect(queue).toContainText("in queue");

  await cronk.checkQueue();

  const timeline = page.getByRole("region", { name: "Timeline" });
  await expect(timeline).toContainText(
    "merged cronkcorp/cronker#1 CRONK-1: change cronkcorp/cronker, waiting in the Merge Queue for its other Pull Requests",
  );
  await expect(queue).toContainText("#1 in queue");

  website.mergeable = true;
  await cronk.checkQueue();

  await expect(timeline).toContainText("completed it: cronkcorp/website#2 CRONK-1: change cronkcorp/website was merged, moving it to Done, Verified by that merge");
});
