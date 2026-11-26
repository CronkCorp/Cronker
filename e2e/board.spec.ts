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
    await page.getByRole("navigation", { name: "Sidebar" }).getByRole("link", { name: "Tickets" }).click();
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
  // Two edge-scrolled drags, each retried below, outlast the default timeout on a loaded CI runner (CRONK-146).
  test.slow();
  const { call, project, open } = await crowdedBoard(page, cronk);
  await call("POST", `/api/projects/${project.id}/tickets`, { title: "Ship it" });
  const { board, lane } = await open();
  const shipIt = (name: string) => lane(name).getByRole("link", { name: /CRONK-1 Ship it/ });
  const anywhere = board.getByRole("link", { name: /CRONK-1 Ship it/ });
  const scrollLeft = () => board.evaluate((e) => e.scrollLeft);
  const frames = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

  // Staging, the last open column, starts past the board's right edge.
  const edge = (await board.boundingBox())!;
  expect((await lane("Staging").boundingBox())!.x, "Staging starts off screen").toBeGreaterThan(edge.x + edge.width);
  const y = edge.y + 60;

  /**
   * Picks the card up, holds it at the board's edge (`at`) until `inView` holds, then drops it at the middle of
   * `column`. The board keeps scrolling for a while after the last dragover (edgeHold in projects.tsx), so before
   * measuring the column the card is moved back to the board's middle, out of the edge zone, and the board left to
   * settle: measured while it still scrolled, the column shifted under the pointer on a slow WebKit runner and the
   * card landed on its neighbour (CRONK-146). Retried, as the board's other drags are (CRONK-128): each attempt picks
   * the card up afresh wherever it is, and stops at once if an earlier attempt's drop has landed after all.
   */
  const edgeDrag = async (at: number, inView: () => Promise<void>, column: string) => {
    await expect(async () => {
      if (await shipIt(column).isVisible()) return;
      await anywhere.scrollIntoViewIfNeeded({ timeout: 3_000 });
      let from = await anywhere.boundingBox({ timeout: 3_000 });
      await expect(async () => {
        const before = from;
        await frames();
        from = await anywhere.boundingBox({ timeout: 3_000 });
        expect(from, "the card has settled").toEqual(before);
      }).toPass({ timeout: 5_000 });
      await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
      await page.mouse.down();
      try {
        const scrolled = await scrollLeft();
        await page.mouse.move(edge.x + edge.width / 2, y, { steps: 5 });
        expect(await scrollLeft(), "the board has not scrolled before the card reaches its edge").toBe(scrolled);
        await expect(async () => {
          await page.mouse.move(at + Math.sign(edge.x + edge.width / 2 - at) * 8, y);
          await page.mouse.move(at, y);
          await inView();
        }).toPass({ timeout: 10_000 });
        // Out of the edge zone, the board stops scrolling: wait until it has, across a few frames.
        await page.mouse.move(edge.x + edge.width / 2, y, { steps: 2 });
        await expect(async () => {
          const before = await scrollLeft();
          await frames();
          await frames();
          expect(await scrollLeft(), "the board has stopped scrolling").toBe(before);
        }).toPass({ timeout: 5_000 });
        await inView();
        const to = (await lane(column).boundingBox())!;
        await page.mouse.move(to.x + to.width / 2, to.y + 80, { steps: 5 });
      } finally {
        await page.mouse.up();
      }
      await expect(shipIt(column), `the card dropped on ${column} is there`).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 60_000 });
  };

  // Held at the board's right edge, it scrolls until Staging comes into view, and the card drops there.
  await edgeDrag(edge.x + edge.width - 4, async () => {
    const staging = (await lane("Staging").boundingBox())!;
    expect(staging.x + staging.width).toBeLessThanOrEqual(edge.x + edge.width);
  }, "Staging");
  await expect(shipIt("Backlog")).toBeHidden();
  expect(await page.evaluate(() => window.scrollX)).toBe(0);

  // And back: held at the board's left edge, it scrolls back until Backlog is in view.
  await edgeDrag(edge.x + 4, async () => {
    expect((await lane("Backlog").boundingBox())!.x).toBeGreaterThanOrEqual(edge.x);
  }, "Backlog");
  await expect(shipIt("Staging")).toBeHidden();
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
  const { secret } = await call("POST", `/api/agents/${agent.id}/tokens`, { name: "cloud", access: "write" });
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
  await page.getByRole("navigation", { name: "Sidebar" }).getByRole("link", { name: "Tickets" }).click();
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
  await page.getByRole("navigation", { name: "Sidebar" }).getByRole("link", { name: "Tickets" }).click();
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
  await expect.poll(async () => (await call("GET", `/api/tickets/${shipIt.id}`)).statusId).toBe(status("Triage"));
  expect(await selected(), "no text is selected by the drag").toBe("");

  // A middle-click on the title opens the Ticket in a new tab and leaves the board where it is (Ctrl/Cmd+click selects
  // the card instead, see board-selection.spec.ts). Retried: on a loaded CI runner a middle-click straight after the
  // native drag (or while the board refetches its Tickets) is now and then swallowed, and no tab opens (CRONK-106).
  if (browserName === "chromium") {
    let opened!: Page;
    await expect(async () => {
      [opened] = await Promise.all([
        page.context().waitForEvent("page", { timeout: 3_000 }),
        card("Triage").locator(".card-title").click({ button: "middle", timeout: 3_000 }),
      ]);
    }).toPass({ timeout: 20_000 });
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
  // Four native drags, each retried below, outlast the default timeout on a loaded CI runner (CRONK-128).
  test.slow();
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
  await page.getByRole("navigation", { name: "Sidebar" }).getByRole("link", { name: "Tickets" }).click();
  const board = page.getByRole("region", { name: "Board" });
  const lane = (name: string) => board.getByRole("region", { name, exact: true });
  const link = (name: string) => lane(name).getByRole("link", { name: /CRONK-2 Ship it/ });
  const card = (name: string) => lane(name).locator(".card").filter({ hasText: "Ship it" });
  await expect(link("Backlog")).toBeVisible();
  const selected = () => page.evaluate(() => window.getSelection()?.toString() ?? "");
  // Vivaldi and Opera, which Playwright can't run, select a link's text on a sideways drag unless the link says
  // draggable="true"; draggable="false" makes them select it always, user-select notwithstanding.
  await expect(link("Backlog"), "the card's link is explicitly draggable").toHaveAttribute("draggable", "true");

  /** A part of the card's box, once it has stopped moving across two animation frames. */
  const settled = async (part: Locator) => {
    let box = await part.boundingBox({ timeout: 3_000 });
    await expect(async () => {
      const before = box;
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      box = await part.boundingBox({ timeout: 3_000 });
      expect(box, "the card has settled").toEqual(before);
    }).toPass({ timeout: 5_000 });
    return box!;
  };

  /** The middle of a part of the card, once its box has settled. */
  const middleOf = (part: Locator) => async () => {
    const box = await settled(part);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };

  /**
   * Presses at a point of the card, moves to the middle of a column and lets go there. Retried: on a loaded CI
   * runner the board may still be refetching or laying out after the previous drop, so the press can land off the
   * card and Firefox starts no native drag (CRONK-128, as for the middle-click in CRONK-106). Each attempt measures
   * the point afresh and stops at once if an earlier attempt's drop has landed after all. A press that landed off the
   * card selects whatever text the move crossed, so each attempt that presses clears the selection first: what the
   * check below sees is then only what the attempt that dragged the card selected (CRONK-173).
   */
  const dragFrom = async (at: () => Promise<{ x: number; y: number }>, column: string) => {
    await expect(async () => {
      if (await link(column).isVisible()) return;
      await page.evaluate(() => window.getSelection()?.removeAllRanges());
      const { x, y } = await at();
      await page.mouse.move(x, y);
      await page.mouse.down();
      try {
        const to = (await lane(column).boundingBox())!;
        await page.mouse.move(to.x + to.width / 2, to.y + 200, { steps: 8 });
      } finally {
        await page.mouse.up();
      }
      await expect(link(column), `the card dropped on ${column} is there`).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 20_000 });
    await expect.poll(async () => (await call("GET", `/api/tickets/${shipIt.id}`)).statusId).toBe(status(column));
    expect(await selected(), "no text is selected by the drag").toBe("");
  };

  // The link's own box, at its top right, where there is no text: its padding, beside the key.
  await dragFrom(async () => {
    const ownBox = await settled(link("Backlog"));
    return { x: ownBox.x + ownBox.width - 6, y: ownBox.y + 4 };
  }, "Triage");

  // A Label in the card's meta row.
  await dragFrom(middleOf(card("Triage").locator(".card-meta .chip").first()), "Ready");

  // The Assignee's avatar at the meta row's right end.
  await dragFrom(middleOf(card("Ready").locator(".card-meta .people")), "Investigate");

  // The card's own empty space, right of its Blocked chip and outside its link.
  await dragFrom(async () => {
    const box = (await card("Investigate").boundingBox({ timeout: 3_000 }))!;
    const { y } = await middleOf(card("Investigate").locator(".chip-blocked"))();
    return { x: box.x + box.width - 10, y };
  }, "Backlog");

  // A plain click on the link, away from its text, still opens the Ticket. Retried, as for the drags: a click straight
  // after a native drag is now and then swallowed on a loaded CI runner (CRONK-128, CRONK-106).
  const heading = page.getByRole("heading", { name: "CRONK-2 Ship it" });
  await expect(async () => {
    if (await heading.isVisible()) return;
    await middleOf(link("Backlog"))();
    const again = (await link("Backlog").boundingBox({ timeout: 3_000 }))!;
    await page.mouse.click(again.x + again.width - 6, again.y + 4);
    await expect(heading).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 20_000 });
});

test("a blocked Ticket sits among the rest of its column and List Status by number, keeping its Blocked chip", async ({
  page,
  cronk,
}) => {
  const { call, project, status, open } = await crowdedBoard(page, cronk);
  const blocker = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Blocker" }); // CRONK-1
  const plainA = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Plain A" }); // CRONK-2
  const blocked = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Blocked" }); // CRONK-3
  const plainB = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Plain B" }); // CRONK-4
  for (const t of [plainA, blocked, plainB]) await call("PATCH", `/api/tickets/${t.id}`, { statusId: status("Ready") });
  await call("POST", `/api/tickets/${blocked.id}/relations`, { kind: "blockedBy", ticketId: blocker.id });

  const { lane } = await open();
  const ready = lane("Ready");
  await expect(ready.getByRole("link", { name: /CRONK-/ })).toHaveText([/CRONK-2 Plain A/, /CRONK-3 Blocked/, /CRONK-4 Plain B/]);
  await expect(ready.locator(".card").filter({ hasText: "Blocked" }).getByRole("button", { name: /^Blocked by 1/ })).toBeVisible();

  await page.getByRole("navigation", { name: "Project views" }).getByRole("link", { name: "List" }).click();
  const list = page.getByRole("region", { name: "List" });
  await expect(list.getByRole("link", { name: /CRONK-[234] / })).toHaveText([/CRONK-2 Plain A/, /CRONK-3 Blocked/, /CRONK-4 Plain B/]);
  await expect(list.getByRole("button", { name: /^Blocked by 1/ })).toBeVisible();
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
  await page.getByRole("navigation", { name: "Sidebar" }).getByRole("link", { name: "Tickets" }).click();
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
  await page.getByRole("navigation", { name: "Sidebar" }).getByRole("link", { name: "Tickets" }).click();
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
  await page.getByRole("navigation", { name: "Sidebar" }).getByRole("link", { name: "Tickets" }).click();
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
  await page.getByRole("navigation", { name: "Sidebar" }).getByRole("link", { name: "Tickets" }).click();
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

test("a queued head behind its base branch shows Updating branch, then Waiting for checks, live, until it merges", async ({ page, cronk }) => {
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
  const check = (sha: string, id: number) =>
    deliver("check_run", {
      action: "completed",
      check_run: { id, name: "test", head_sha: sha, status: "completed", conclusion: "success", html_url: null },
    });
  // CRONK-1 in In Review, its Pull Request green and merging cleanly but behind main; a User queues it.
  const ticket = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Change 1" });
  await call("PATCH", `/api/tickets/${ticket.id}`, { statusId: inReview });
  const pullRequest = {
    id: 501, number: 1, title: "CRONK-1: change 1", state: "open", draft: false, merged: false,
    html_url: "https://github.com/cronkcorp/cronker/pull/1", head: { ref: "cronk-1", sha: "c1" }, base: { ref: "main" },
    updated_at: "2026-01-01T09:00:00Z",
  };
  await deliver("pull_request", { action: "opened", pull_request: pullRequest });
  await check("c1", 1);
  cronk.github.pullRequest(cronker, 1, { headSha: "c1", mergeable: true, behind: true });
  await call("POST", `/api/tickets/${ticket.id}/merge`);

  await signInInBrowser(page, cronk);
  await page.getByRole("navigation", { name: "Sidebar" }).getByRole("link", { name: "Tickets" }).click();
  const cards = page.getByRole("region", { name: "Board" }).getByRole("region", { name: "Merge", exact: true }).locator(".card-link");
  await expect(cards).toHaveText([/CRONK-1.*#1 in queue/]);

  // The pass asks GitHub to update its branch: the card says so while GitHub is asked, then waits for the checks.
  cronk.github.onUpdate = async () => {
    await expect(cards).toHaveText([/CRONK-1.*Updating branch/]);
  };
  await cronk.checkQueue();
  await expect(cards).toHaveText([/CRONK-1.*Waiting for checks/]);
  expect(cronk.github.merges).toEqual([]);

  // GitHub reports the new commit and its green check, which merges it at once.
  await deliver("pull_request", {
    action: "synchronize",
    pull_request: { ...pullRequest, head: { ref: "cronk-1", sha: "c1u1" }, updated_at: "2026-01-01T09:10:00Z" },
  });
  await check("c1u1", 2);
  await expect(cards).toHaveCount(0);
  expect(cronk.github.merges.map((m) => m.sha)).toEqual(["c1u1"]);
});


test("a queued head conflicting with its base branch shows Resolving conflict, then Waiting for checks, live", async ({ page, cronk }) => {
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
  const runner = await call("POST", "/api/runners", { name: "Fake", kind: "fake" });
  const created = await call("POST", `/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
  const agent = await call("PATCH", `/api/agents/${created.id}`, { runnerId: runner.id });
  const { secret } = await call("POST", `/api/agents/${agent.id}/tokens`, { name: "cloud", access: "write" });
  const deliver = async (event: string, payload: Record<string, unknown>) => {
    const delivered = await cronk.github.deliver(app, event, {
      installation: { id: installation.id },
      repository: { id: cronker.id, full_name: cronker.fullName },
      ...payload,
    });
    expect(delivered.status).toBe(200);
  };
  // CRONK-1 and CRONK-2 in In Review, delegated, their Pull Requests green; CRONK-1 merging makes CRONK-2 conflict.
  const onGitHub: ReturnType<typeof cronk.github.pullRequest>[] = [];
  const tickets: { id: string }[] = [];
  for (const number of [1, 2]) {
    const ticket = await call("POST", `/api/projects/${project.id}/tickets`, { title: `Change ${number}` });
    await call("PATCH", `/api/tickets/${ticket.id}`, { statusId: inReview, delegateId: agent.id, autonomousDelegation: false });
    await deliver("pull_request", {
      action: "opened",
      pull_request: {
        id: 500 + number, number, title: `CRONK-${number}: change ${number}`, state: "open", draft: false, merged: false,
        html_url: `https://github.com/cronkcorp/cronker/pull/${number}`, head: { ref: `cronk-${number}`, sha: `c${number}` },
        base: { ref: "main" }, updated_at: "2026-01-01T09:00:00Z",
      },
    });
    await deliver("check_run", {
      action: "completed",
      check_run: { id: number, name: "test", head_sha: `c${number}`, status: "completed", conclusion: "success", html_url: null },
    });
    onGitHub.push(cronk.github.pullRequest(cronker, number, { headSha: `c${number}`, mergeable: true }));
    tickets.push(ticket);
    await call("POST", `/api/tickets/${ticket.id}/merge`);
  }
  onGitHub[0]!.conflicts = [onGitHub[1]!];

  await signInInBrowser(page, cronk);
  await page.getByRole("navigation", { name: "Sidebar" }).getByRole("link", { name: "Tickets" }).click();
  const cards = page.getByRole("region", { name: "Board" }).getByRole("region", { name: "Merge", exact: true }).locator(".card-link");
  await expect(cards).toHaveText([/CRONK-1.*#1 in queue/, /CRONK-2.*#2 in queue/]);

  await cronk.checkQueue();
  await cronk.checkQueue();
  await expect(cards).toHaveText([/CRONK-2.*Resolving conflict/]);

  // Its Merge Run pushes a resolution and finishes resolved.
  const runs = await call("GET", `/api/tickets/${tickets[1]!.id}/runs`);
  const run = runs.find((r: { state: string }) => r.state === "running");
  await cronk.request("POST", `/api/runs/${run.id}/finish`, { headers: { authorization: `Bearer ${secret}` }, body: { outcome: "resolved" } });
  await expect(cards).toHaveText([/CRONK-2.*Waiting for checks/]);
});

test("a Ticket of a cut Release merging after the Cut shows Backporting in Merge, live, until its backport joins the queue", async ({ page, cronk }) => {
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
  const runner = await call("POST", "/api/runners", { name: "Fake", kind: "fake" });
  const created = await call("POST", `/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
  const agent = await call("PATCH", `/api/agents/${created.id}`, { runnerId: runner.id });
  const { secret } = await call("POST", `/api/agents/${agent.id}/tokens`, { name: "cloud", access: "write" });
  const deliver = async (event: string, payload: Record<string, unknown>) => {
    const delivered = await cronk.github.deliver(app, event, {
      installation: { id: installation.id },
      repository: { id: cronker.id, full_name: cronker.fullName },
      ...payload,
    });
    expect(delivered.status).toBe(200);
  };
  const open = async (number: number, base: string) => {
    await deliver("pull_request", {
      action: "opened",
      pull_request: {
        id: 500 + number, number, title: `CRONK-1: change ${number}`, state: "open", draft: false, merged: false,
        html_url: `https://github.com/cronkcorp/cronker/pull/${number}`, head: { ref: `cronk-${number}`, sha: `c${number}` },
        base: { ref: base }, updated_at: "2026-01-01T09:00:00Z",
      },
    });
    await deliver("check_run", {
      action: "completed",
      check_run: { id: number, name: "test", head_sha: `c${number}`, status: "completed", conclusion: "success", html_url: null },
    });
    cronk.github.pullRequest(cronker, number, { headSha: `c${number}`, mergeable: true, base });
  };
  // CRONK-1, tagged v0.3.0, in In Review with its Pull Request green; the Release is cut, then a User queues it.
  const release = await call("POST", `/api/projects/${project.id}/releases`, { name: "v0.3.0" });
  const ticket = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Change 1", release: "v0.3.0" });
  await call("PATCH", `/api/tickets/${ticket.id}`, { statusId: inReview, delegateId: agent.id, autonomousDelegation: false });
  await open(1, "main");
  await call("POST", `/api/projects/${project.id}/releases/${release.id}/cut`);
  cronk.clock.advance(60 * 60 * 1000);
  await call("POST", `/api/tickets/${ticket.id}/merge`);

  await signInInBrowser(page, cronk);
  await page.getByRole("navigation", { name: "Sidebar" }).getByRole("link", { name: "Tickets" }).click();
  const cards = page.getByRole("region", { name: "Board" }).getByRole("region", { name: "Merge", exact: true }).locator(".card-link");
  await expect(cards).toHaveText([/CRONK-1.*#1 in queue/]);

  // Merging into main after the Cut holds it in Merge while a Merge Run backports it.
  await cronk.checkQueue();
  await expect(cards).toHaveText([/CRONK-1.*Backporting/]);

  // The Run opens the backport and finishes backported: it joins the release branch's queue as the User's.
  await open(2, "release/v0.3.0");
  const runs = await call("GET", `/api/tickets/${ticket.id}/runs`);
  const run = runs.find((r: { state: string }) => r.state === "running");
  await cronk.request("POST", `/api/runs/${run.id}/finish`, { headers: { authorization: `Bearer ${secret}` }, body: { outcome: "backported" } });
  await expect(cards).toHaveText([/CRONK-1.*#1 in queue/]);
  await expect(cards.first()).not.toContainText("Backporting");
});
