import { setUp, signIn } from "../test/harness/flows.js";
import type { Page } from "@playwright/test";
import type { StartedCronk } from "../test/harness/start-cronk.js";
import { expect, signInInBrowser, test } from "./fixtures.js";

/** A Project named Cronker with four Backlog Tickets, its board open. */
async function board(page: Page, cronk: StartedCronk) {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const call = async (method: string, path: string, body?: unknown) => (await cronk.request(method, path, { cookie, body })).json();
  const project = await call("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const tickets = [];
  for (const title of ["One", "Two", "Three", "Four"]) {
    tickets.push(await call("POST", `/api/projects/${project.id}/tickets`, { title }));
  }
  await signInInBrowser(page, cronk);
  await page.getByRole("link", { name: "CRONK Cronker" }).click();
  const shown = page.getByRole("region", { name: "Board" });
  const lane = (name: string) => shown.getByRole("region", { name, exact: true });
  await expect(lane("Backlog").getByRole("link")).toHaveCount(4);
  const cards = (column: string) => lane(column).getByRole("link");
  const selected = (column: string) => lane(column).getByRole("link", { name: /, selected$/ });
  const count = page.getByRole("status").filter({ hasText: "selected" });
  return { call, project, tickets, lane, cards, selected, count };
}

test("Ctrl/Cmd+click and Shift+click select three cards without opening them, and dragging one moves all three", async ({
  page,
  cronk,
}) => {
  const { lane, cards, selected, count } = await board(page, cronk);
  const address = page.url();

  await cards("Backlog").nth(0).click({ modifiers: ["ControlOrMeta"] });
  await expect(selected("Backlog")).toHaveCount(1);
  await expect(count).toHaveText(/1 selected/);
  // Shift+click selects the range from the first card picked down to this one, in the column as shown.
  await cards("Backlog").nth(2).click({ modifiers: ["Shift"] });
  await expect(selected("Backlog")).toHaveCount(3);
  await expect(count).toHaveText(/3 selected/);
  await expect(cards("Backlog").nth(3)).not.toHaveAccessibleName(/selected/);
  // Nothing opened, in this tab or another.
  expect(page.url()).toBe(address);
  expect(page.context().pages()).toHaveLength(1);

  // Ctrl/Cmd+click on a selected card takes it out; again puts it back.
  await cards("Backlog").nth(1).click({ modifiers: ["ControlOrMeta"] });
  await expect(selected("Backlog")).toHaveCount(2);
  await cards("Backlog").nth(1).click({ modifiers: ["ControlOrMeta"] });
  await expect(selected("Backlog")).toHaveCount(3);

  const moving = (await selected("Backlog").allTextContents()).map((text) => text.replace(", selected", ""));
  await selected("Backlog").nth(1).dragTo(lane("Ready"));
  await expect(cards("Ready")).toHaveCount(3);
  await expect(cards("Backlog")).toHaveCount(1);
  expect((await cards("Ready").allTextContents()).sort()).toEqual(moving.sort());
  // The moved Tickets leave the selection.
  await expect(count).toBeHidden();
  await page.reload();
  await expect(cards("Ready")).toHaveCount(3);

  // A card that isn't selected drags alone, leaving the selection as it is.
  await cards("Ready").nth(0).click({ modifiers: ["ControlOrMeta"] });
  await cards("Backlog").nth(0).dragTo(lane("Triage"));
  await expect(cards("Triage")).toHaveCount(1);
  await expect(cards("Ready")).toHaveCount(3);
  await expect(selected("Ready")).toHaveCount(1);
});

test("Space and Shift+Space select by keyboard, Escape clears, and Move to on a selected card moves the whole selection", async ({
  page,
  cronk,
}) => {
  const { cards, selected, count } = await board(page, cronk);

  await cards("Backlog").nth(1).focus();
  await page.keyboard.press("Space");
  await expect(selected("Backlog")).toHaveCount(1);
  await page.keyboard.press("Space");
  await expect(selected("Backlog")).toHaveCount(0);
  await page.keyboard.press("Space");
  await cards("Backlog").nth(3).focus();
  await page.keyboard.press("Shift+Space");
  await expect(selected("Backlog")).toHaveCount(3);
  await expect(count).toHaveText(/3 selected/);

  await page.keyboard.press("Escape");
  await expect(selected("Backlog")).toHaveCount(0);
  await expect(count).toBeHidden();

  // Selected again, its menu offers Move to for all of them; Escape closes the menu first, keeping the selection.
  await cards("Backlog").nth(0).click({ modifiers: ["ControlOrMeta"] });
  await cards("Backlog").nth(2).click({ modifiers: ["Shift"] });
  await selected("Backlog").nth(0).focus();
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "Move 3 Tickets to" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Delegate to" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(selected("Backlog")).toHaveCount(3);

  await selected("Backlog").nth(0).click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Move 3 Tickets to" }).click();
  const statuses = page.getByRole("menu", { name: "Move 3 Tickets to" });
  await expect(statuses.getByRole("menuitemradio", { checked: true })).toHaveCount(0);
  await statuses.getByRole("menuitemradio", { name: "Ready" }).click();
  await expect(cards("Ready")).toHaveCount(3);
  await expect(cards("Backlog")).toHaveCount(1);
});

test("a selection's refused moves are listed per Ticket, the rest still move, and the refused stay selected", async ({
  page,
  cronk,
}) => {
  const { tickets, lane, cards, selected, count } = await board(page, cronk);
  // Cronk refuses the move of CRONK-2, as it would a rule's refusal.
  const refused = tickets[1];
  await page.route(`**/api/tickets/${refused.id}`, (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "refused", message: "That move isn't allowed." } }),
        })
      : route.continue(),
  );

  await cards("Backlog").nth(0).click({ modifiers: ["ControlOrMeta"] });
  await cards("Backlog").nth(2).click({ modifiers: ["Shift"] });
  await expect(count).toHaveText(/3 selected/);
  await selected("Backlog").nth(0).dragTo(lane("Ready"));

  const alert = page.getByRole("alert");
  await expect(alert).toContainText("1 of 3 Tickets not moved:");
  await expect(alert.getByRole("listitem")).toHaveText([`${refused.key}: That move isn't allowed.`]);
  await expect(cards("Ready")).toHaveCount(2);
  await expect(selected("Backlog")).toHaveCount(1);
  await expect(selected("Backlog")).toHaveAccessibleName(new RegExp(`^${refused.key} `));
  await expect(count).toHaveText(/1 selected/);
});
