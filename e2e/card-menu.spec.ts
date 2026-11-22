import { setUp, signIn } from "../test/harness/flows.js";
import type { Page } from "@playwright/test";
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
