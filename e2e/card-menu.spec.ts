import { addMember, setUp, signIn } from "../test/harness/flows.js";
import type { Locator, Page } from "@playwright/test";
import type { StartedCronk } from "../test/harness/start-cronk.js";
import { expect, signInInBrowser, test } from "./fixtures.js";

/**
 * A Project named Cronker on its default board, Ada with an Agent of her own on the fake Runner, and Grace, another
 * member, with one of hers.
 */
async function board(page: Page, cronk: StartedCronk) {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const call = async (method: string, path: string, body?: unknown) => (await cronk.request(method, path, { cookie, body })).json();
  const project = await call("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id;
  const runner = await call("POST", "/api/runners", { name: "Fake", kind: "fake" });
  const agent = async (name: string) => {
    const made = await call("POST", `/api/workspaces/${workspace.id}/agents`, { name });
    await call("PATCH", `/api/agents/${made.id}`, { runnerId: runner.id });
    return made;
  };
  const me = (await call("GET", "/api/me")).user;
  const open = async (on: Page = page) => {
    if (on === page) await signInInBrowser(on, cronk);
    else await on.goto(page.url());
    if (on === page) await on.getByRole("link", { name: "CRONK Cronker" }).click();
    const shown = on.getByRole("region", { name: "Board" });
    await expect(shown.getByRole("region", { name: "Backlog", exact: true })).toBeVisible();
    const lane = (name: string) => shown.getByRole("region", { name, exact: true });
    return { board: shown, lane, card: (column: string, name: RegExp) => lane(column).getByRole("link", { name }) };
  };
  return { workspace, cookie, call, project, status, agent, me, open };
}

/**
 * Moves the pointer onto a menu item step by step, as a hand does, then clicks it. A pointer that jumps from Delegate
 * to straight into its menu, flipped to the left at the board's edge, would leave Delegate to the wrong way and close it.
 */
async function choose(page: Page, item: Locator) {
  const box = (await item.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
  await item.click();
}

test("a focused card opens its menu with Shift+F10 or the ContextMenu key, and Move to moves it as a drop does, starting a Run", async ({
  page,
  cronk,
}) => {
  const { call, project, status, agent, open } = await board(page, cronk);
  const claude = await agent("claude-max");
  const shipIt = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Ship it" });
  await call("PATCH", `/api/tickets/${shipIt.id}`, { delegateId: claude.id });
  const { card } = await open();
  // Another board open on the same Project follows the move live.
  const other = await page.context().newPage();
  const elsewhere = await open(other);

  await card("Backlog", /CRONK-1 Ship it/).focus();
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu", { name: "CRONK-1 Ship it" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Move to" })).toBeFocused();

  // Arrow keys reach Move to's Statuses, each with its dot and its Step's model label, the current one checked.
  await page.keyboard.press("ArrowRight");
  const statuses = page.getByRole("menu", { name: "Move to" });
  const names = ["Backlog", "Triage", "Ready", "Investigate", "Implement", "Code review", "Merge", "In Review", "Done", "Canceled"];
  await expect(statuses.getByRole("menuitemradio")).toHaveText([
    "Backlog",
    "Triagehaiku",
    "Ready",
    "Investigatesonnet",
    "Implementopus",
    "Code reviewsonnet",
    "Mergehaiku",
    "In Review",
    "Done",
    "Canceled",
  ]);
  for (const name of names) {
    await expect(statuses.getByRole("menuitemradio", { name: new RegExp(`^${name}`) })).toHaveAttribute(
      "aria-checked",
      name === "Backlog" ? "true" : "false",
    );
  }
  await expect(statuses.getByRole("menuitemradio").first().locator(".status-dot")).toHaveCount(1);
  await expect(statuses.getByRole("menuitemradio", { name: "Backlog" })).toBeFocused();

  // Triage has a Step: moving the delegated Ticket there starts a Run, as dropping the card there does.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  await expect(card("Triage", /CRONK-1 Ship it/)).toBeVisible();
  await expect(card("Backlog", /CRONK-1 Ship it/)).toBeHidden();
  expect((await call("GET", `/api/tickets/${shipIt.id}`)).statusId).toBe(status("Triage"));
  await expect.poll(() => cronk.runner.starts.length).toBe(1);
  await expect(elsewhere.card("Triage", /CRONK-1 Ship it/)).toBeVisible();

  // The ContextMenu key opens it too, the new Status now checked; Escape closes it and gives focus back to the card.
  await card("Triage", /CRONK-1 Ship it/).focus();
  await page.keyboard.press("ContextMenu");
  await expect(menu).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(statuses.getByRole("menuitemradio", { name: /^Triage/ })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(card("Triage", /CRONK-1 Ship it/)).toBeFocused();
});

test("right-clicking a card opens its menu instead of the browser's, and Delegate to lists only the User's own Agents, stopping a running Run on a change", async ({
  page,
  cronk,
}) => {
  const { workspace, cookie, call, project, status, agent, me, open } = await board(page, cronk);
  const claude = await agent("claude-max");
  const codex = await agent("codex");
  const grace = await addMember(cronk, cookie, workspace.id, "grace@example.com");
  await cronk.request("POST", `/api/workspaces/${workspace.id}/agents`, { cookie: grace.cookie, body: { name: "graces-agent" } });
  const shipIt = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Ship it" });
  // In Ready, which has no Step, so delegating it starts no Run.
  await call("PATCH", `/api/tickets/${shipIt.id}`, { statusId: status("Ready") });
  expect((await call("GET", `/api/tickets/${shipIt.id}`)).assigneeId).toBeNull();
  const { card } = await open();

  // The browser's own menu doesn't open over the card: Cronk's does.
  const shipItCard = () => card("Ready", /CRONK-1 Ship it/);
  const prevented = shipItCard().evaluate(
    (link) => new Promise<boolean>((resolve) => window.addEventListener("contextmenu", (event) => resolve(event.defaultPrevented), { once: true })),
  );
  await shipItCard().click({ button: "right" });
  expect(await prevented, "the browser's own context menu is held back").toBe(true);
  const menu = page.getByRole("menu", { name: "CRONK-1 Ship it" });
  await expect(menu).toBeVisible();
  // Nor over the menu itself, as when a browser sends its own on the keyup of the key that opened it.
  const overMenu = await menu.evaluate((element) => {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(overMenu, "the browser's own context menu is held back over the open menu").toBe(true);
  // Autonomous Delegation is offered only while the Ticket is delegated.
  await expect(menu.getByRole("menuitemcheckbox", { name: "Autonomous Delegation" })).toHaveCount(0);

  // Only Ada's own Agents, none checked yet, then Undelegate, with nothing to undo.
  await menu.getByRole("menuitem", { name: "Delegate to" }).click();
  const delegates = page.getByRole("menu", { name: "Delegate to" });
  await expect(delegates.getByRole("menuitemradio")).toHaveText(["claude-max", "codex"]);
  await expect(delegates.getByRole("menuitemradio", { checked: true })).toHaveCount(0);
  await expect(delegates.getByRole("menuitem", { name: "Undelegate" })).toBeDisabled();

  // Delegating the unassigned Ticket assigns Ada too, shown on the card at once.
  await choose(page, delegates.getByRole("menuitemradio", { name: /claude-max/ }));
  await expect(menu).toBeHidden();
  await expect(shipItCard().getByTitle("Delegate: claude-max")).toBeVisible();
  await expect(shipItCard().getByTitle("Assignee: ada@example.com")).toBeVisible();
  const delegated = await call("GET", `/api/tickets/${shipIt.id}`);
  expect(delegated.delegateId).toBe(claude.id);
  expect(delegated.assigneeId).toBe(me.id);

  // Into Implement, with a Step: a Run starts. Re-delegating to codex stops it, its Delegate now checked.
  await call("PATCH", `/api/tickets/${shipIt.id}`, { statusId: status("Implement") });
  expect(cronk.runner.starts).toHaveLength(1);
  const running = () => card("Implement", /CRONK-1 Ship it/);
  await running().click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Delegate to" }).click();
  await expect(delegates.getByRole("menuitemradio", { name: /claude-max/ })).toHaveAttribute("aria-checked", "true");
  await choose(page, delegates.getByRole("menuitemradio", { name: /codex/ }));
  await expect(running().getByTitle("Delegate: codex")).toBeVisible();
  expect((await call("GET", `/api/tickets/${shipIt.id}`)).delegateId).toBe(codex.id);
  await expect.poll(() => cronk.runner.stops.length).toBe(1);

  // Undelegating stops the Run codex's Delegation started in turn.
  await expect.poll(() => cronk.runner.starts.length).toBe(2);
  await running().click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Delegate to" }).click();
  await choose(page, delegates.getByRole("menuitem", { name: "Undelegate" }));
  await expect(running().getByTitle("Delegate: codex")).toBeHidden();
  expect((await call("GET", `/api/tickets/${shipIt.id}`)).delegateId).toBeNull();
  await expect.poll(() => cronk.runner.stops.length).toBe(2);
});

test("a long press opens a card's menu on a touch screen, and Autonomous Delegation, offered once it is delegated, flips live on every open board", async ({
  page,
  cronk,
}) => {
  const { call, project, agent, open } = await board(page, cronk);
  const claude = await agent("claude-max");
  const shipIt = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Ship it" });
  await call("PATCH", `/api/tickets/${shipIt.id}`, { delegateId: claude.id, autonomousDelegation: false });
  const { card } = await open();
  const other = await page.context().newPage();
  const elsewhere = await open(other);

  // A finger held on the card for a moment, as a touch screen sends it.
  const longPress = async () => {
    const box = (await card("Backlog", /CRONK-1 Ship it/).boundingBox())!;
    const at = { pointerType: "touch", isPrimary: true, clientX: box.x + 20, clientY: box.y + 20, bubbles: true };
    await card("Backlog", /CRONK-1 Ship it/).dispatchEvent("pointerdown", at);
    await page.waitForTimeout(800);
    await card("Backlog", /CRONK-1 Ship it/).dispatchEvent("pointerup", at);
  };
  await longPress();
  const menu = page.getByRole("menu", { name: "CRONK-1 Ship it" });
  await expect(menu).toBeVisible();
  const autonomous = menu.getByRole("menuitemcheckbox", { name: "Autonomous Delegation" });
  await expect(autonomous).toHaveAttribute("aria-checked", "false");
  await autonomous.click();
  await expect(menu).toBeHidden();
  await expect.poll(async () => (await call("GET", `/api/tickets/${shipIt.id}`)).autonomousDelegation).toBe(true);

  // The other open board takes the change in: its menu now shows it on, and turning it off there shows here.
  await elsewhere.card("Backlog", /CRONK-1 Ship it/).click({ button: "right" });
  const otherMenu = other.getByRole("menu", { name: "CRONK-1 Ship it" });
  await expect(otherMenu.getByRole("menuitemcheckbox", { name: "Autonomous Delegation" })).toHaveAttribute("aria-checked", "true");
  await otherMenu.getByRole("menuitemcheckbox", { name: "Autonomous Delegation" }).click();
  await expect.poll(async () => (await call("GET", `/api/tickets/${shipIt.id}`)).autonomousDelegation).toBe(false);
  await card("Backlog", /CRONK-1 Ship it/).click({ button: "right" });
  await expect(autonomous).toHaveAttribute("aria-checked", "false");
});

test("a move Cronk refuses from a card's menu says why above the board, and the card stays", async ({ page, cronk }) => {
  const { call, project, status, agent, open } = await board(page, cronk);
  const claude = await agent("claude-max");
  const { secret } = await call("POST", `/api/agents/${claude.id}/tokens`, { name: "cloud", access: "full" });
  // A Ticket a Run completed: Unverified in Done, it leaves only by Accept or Reopen.
  const shipped = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Shipped" });
  await call("PATCH", `/api/tickets/${shipped.id}`, { delegateId: claude.id, autonomousDelegation: true, statusId: status("Code review") });
  const [run] = await call("GET", `/api/tickets/${shipped.id}/runs`);
  await cronk.request("POST", `/api/runs/${run.id}/finish`, { headers: { authorization: `Bearer ${secret}` }, body: { outcome: "complete" } });
  expect((await call("GET", `/api/tickets/${shipped.id}`)).verification).toBe("unverified");
  const { board: shown, lane, card } = await open();

  await shown.evaluate((e) => (e.scrollLeft = e.scrollWidth));
  await lane("Done").getByRole("button", { name: "Done, 1 Ticket" }).click();
  await card("Done", /CRONK-1 Shipped/).focus();
  await page.keyboard.press("Shift+F10");
  await page.keyboard.press("ArrowRight");
  await page.getByRole("menu", { name: "Move to" }).getByRole("menuitemradio", { name: "In Review" }).press("Enter");
  const refusal = page.getByRole("alert");
  await expect(refusal).toHaveText("CRONK-1 was completed by a Run and is Unverified: it leaves Done only by Accept or Reopen.");
  expect((await refusal.boundingBox())!.y, "the reason shows above the board").toBeLessThan((await shown.boundingBox())!.y);
  await expect(card("Done", /CRONK-1 Shipped/)).toBeVisible();
});
