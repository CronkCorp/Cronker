import { createGitHubApp, setUp, signIn } from "../test/harness/flows.js";
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
    if (on === page) await on.getByRole("navigation", { name: "Sidebar" }).getByRole("link", { name: "Tickets" }).click();
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
  // The move waits on its save, which starts the Run inside the request: on a busy CI runner that alone can take
  // seconds, so the cards are given longer than the default to follow, and a save that fails says so here.
  await page.keyboard.press("ArrowDown");
  await expect(statuses.getByRole("menuitemradio", { name: /^Triage/ })).toBeFocused();
  const saved = page.waitForResponse(
    (response) => response.request().method() === "PATCH" && response.url().endsWith(`/api/tickets/${shipIt.id}`),
  );
  await page.keyboard.press("Enter");
  expect((await saved).status()).toBe(200);
  await expect(menu).toBeHidden();
  expect((await call("GET", `/api/tickets/${shipIt.id}`)).statusId).toBe(status("Triage"));
  await expect(card("Triage", /CRONK-1 Ship it/)).toBeVisible({ timeout: 15_000 });
  await expect(card("Backlog", /CRONK-1 Ship it/)).toBeHidden({ timeout: 15_000 });
  await expect.poll(() => cronk.runner.starts.length, { timeout: 15_000 }).toBe(1);
  await expect(elsewhere.card("Triage", /CRONK-1 Ship it/)).toBeVisible({ timeout: 15_000 });

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

test("a card's menu opens its session and Pull Requests, retries a Run gone wrong and copies, following live updates", async ({
  page,
  cronk,
}) => {
  const { cookie, call, project, status, agent, open } = await board(page, cronk);
  await createGitHubApp(cronk, cookie);
  const app = cronk.github.apps[0]!;
  const installation = cronk.github.install(app, "cronkcorp", ["cronker"]);
  const cronker = installation.repositories[0]!;
  await call("POST", `/api/projects/${project.id}/repositories`, { id: cronker.id });
  const claude = await agent("claude-max");
  const shipIt = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Ship it" });
  await call("PATCH", `/api/tickets/${shipIt.id}`, { delegateId: claude.id });
  // What the menu copies, kept where the test reads it back.
  await page.addInitScript(() => {
    const copied: string[] = [];
    Object.assign(window, { copied });
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => void copied.push(text) } });
  });
  const { card } = await open();
  const menu = page.getByRole("menu", { name: "CRONK-1 Ship it" });
  const openMenu = async (column: string) => {
    await card(column, /CRONK-1 Ship it/).click({ button: "right" });
    await expect(menu).toBeVisible();
  };
  const closeMenu = async () => {
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
  };

  // Before any Run or Pull Request, only the Ticket's own links and copies are under the write items.
  await openMenu("Backlog");
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Move to›",
    "Delegate to›",
    "Open in new tab",
    "Copy link",
    "Copy key",
  ]);
  const newTab = menu.getByRole("menuitem", { name: "Open in new tab" });
  await expect(newTab).toHaveAttribute("href", /\/tickets\/CRONK-1$/);
  await expect(newTab).toHaveAttribute("target", "_blank");
  await menu.getByRole("menuitem", { name: "Copy key" }).click();
  await expect(menu).toBeHidden();
  await openMenu("Backlog");
  await menu.getByRole("menuitem", { name: "Copy link" }).click();
  expect(await page.evaluate(() => (window as unknown as { copied: string[] }).copied)).toEqual([
    "CRONK-1",
    expect.stringMatching(/^http:\/\/[^/]+\/.+\/tickets\/CRONK-1$/),
  ]);

  // A Run starts: its session shows, in a new tab.
  await call("PATCH", `/api/tickets/${shipIt.id}`, { statusId: status("Triage") });
  await expect(card("Triage", /CRONK-1 Ship it/)).toBeVisible();
  await expect.poll(() => cronk.runner.starts.length).toBe(1);
  await openMenu("Triage");
  const session = menu.getByRole("menuitem", { name: "Open session" });
  await expect(session).toHaveAttribute("href", "https://claude.ai/code/cse_1");
  await expect(session).toHaveAttribute("target", "_blank");
  await expect(session).toHaveAttribute("rel", /noopener/);
  await expect(menu.getByRole("menuitem", { name: "Retry" })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "Open Pull Request" })).toHaveCount(0);
  await closeMenu();

  // A Pull Request is linked while the board is open: it shows, with its branch to copy.
  const pullRequest = async (id: number, number: number, branch: string) => {
    const delivered = await cronk.github.deliver(app, "pull_request", {
      action: "opened",
      installation: { id: installation.id },
      repository: { id: cronker.id, full_name: cronker.fullName },
      pull_request: {
        id, number, title: "CRONK-1: ship it", state: "open", draft: false, merged: false, base: { ref: "main" },
        html_url: `https://github.com/cronkcorp/cronker/pull/${number}`, head: { ref: branch, sha: `s${id}` },
        updated_at: "2026-01-01T09:00:00Z",
      },
    });
    expect(delivered.status).toBe(200);
  };
  await pullRequest(501, 7, "feat/CRONK-1-ship-it");
  await expect(async () => {
    await openMenu("Triage");
    await expect(menu.getByRole("menuitem", { name: "Open Pull Request" })).toHaveAttribute(
      "href",
      "https://github.com/cronkcorp/cronker/pull/7",
      { timeout: 500 },
    );
  }).toPass();
  await expect(menu.getByRole("menuitem", { name: "Open Pull Request" })).toHaveAttribute("rel", /noopener/);
  await menu.getByRole("menuitem", { name: "Copy branch name" }).click();
  expect(await page.evaluate(() => (window as unknown as { copied: string[] }).copied.at(-1))).toBe("feat/CRONK-1-ship-it");

  // With a second, each is listed by Repository and number with its state, and no one branch is offered.
  await pullRequest(502, 9, "fix/CRONK-1-again");
  await expect(async () => {
    await page.keyboard.press("Escape");
    await openMenu("Triage");
    await expect(menu.getByRole("menuitem", { name: "Copy branch name" })).toHaveCount(0, { timeout: 500 });
  }).toPass();
  await menu.getByRole("menuitem", { name: "Open Pull Request" }).click();
  const pullRequests = page.getByRole("menu", { name: "Open Pull Request" });
  await expect(pullRequests.getByRole("menuitem")).toHaveText(["cronkcorp/cronker#7 open", "cronkcorp/cronker#9 open"]);
  await expect(pullRequests.getByRole("menuitem", { name: /#9/ })).toHaveAttribute("href", "https://github.com/cronkcorp/cronker/pull/9");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();

  // The Run goes wrong: Retry shows, and starts a fresh Run of the same Step.
  const [run] = await call("GET", `/api/tickets/${shipIt.id}/runs`);
  await cronk.runner.endWithoutFinishing(run.id, "The session crashed.");
  await expect(async () => {
    await page.keyboard.press("Escape");
    await openMenu("Triage");
    await expect(menu.getByRole("menuitem", { name: "Retry" })).toBeVisible({ timeout: 500 });
  }).toPass();
  await menu.getByRole("menuitem", { name: "Retry" }).click();
  await expect.poll(() => cronk.runner.starts.length).toBe(2);
  await openMenu("Triage");
  await expect(menu.getByRole("menuitem", { name: "Retry" })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "Open session" })).toHaveAttribute("href", "https://claude.ai/code/cse_2");
});
