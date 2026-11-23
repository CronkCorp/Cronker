import type { Page } from "@playwright/test";
import type { StartedCronk } from "../test/harness/start-cronk.js";
import { expect, test } from "./fixtures.js";

/**
 * Ada's Inbox across two Projects: a Question and the Ticket its needs you Outcome handed back (CRONK-1), an Unverified
 * completion in CRONK (CRONK-2) and one in WEB (WEB-1). Gives a way to complete another Ticket while the Inbox is open.
 */
async function inboxOfTwoProjects(page: Page, cronk: StartedCronk) {
  const credentials = { email: "ada@example.com", password: "correct horse battery" };
  const { workspace } = await (
    await cronk.request("POST", "/api/setup", { body: { ...credentials, setupCode: cronk.setupCode(), workspaceName: "Ada's Workspace" } })
  ).json();
  const cookie = (await cronk.request("POST", "/api/sign-in", { body: credentials })).headers.get("set-cookie")!.split(";")[0]!;
  const call = async (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
    (await cronk.request(method, path, headers ? { headers, body } : { cookie, body })).json();
  const cronker = await call("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const web = await call("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Website", key: "WEB" });
  const status = (project: { statuses: { name: string; id: string }[] }, name: string) => project.statuses.find((s) => s.name === name)!.id;
  const runner = await call("POST", "/api/runners", { name: "Fake", kind: "fake" });
  const agent = await call("POST", `/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
  await call("PATCH", `/api/agents/${agent.id}`, { runnerId: runner.id });
  const { secret } = await call("POST", `/api/agents/${agent.id}/tokens`, { name: "cloud", access: "write" });
  const finish = async (ticketId: string, body: object) => {
    const runs = await call("GET", `/api/tickets/${ticketId}/runs`);
    const running = runs.find((r: { state: string }) => r.state === "running");
    await call("POST", `/api/runs/${running.id}/finish`, body, { authorization: `Bearer ${secret}` });
  };
  const complete = async (project: { id: string; statuses: { name: string; id: string }[] }, title: string) => {
    const ticket = await call("POST", `/api/projects/${project.id}/tickets`, { title });
    await call("PATCH", `/api/tickets/${ticket.id}`, { delegateId: agent.id, autonomousDelegation: true, statusId: status(project, "Code review") });
    await finish(ticket.id, { outcome: "complete" });
  };
  const asked = await call("POST", `/api/projects/${cronker.id}/tickets`, { title: "Pick a colour" });
  await call("PATCH", `/api/tickets/${asked.id}`, { delegateId: agent.id, statusId: status(cronker, "Triage") });
  await finish(asked.id, { outcome: "needs you", question: "Blue or green?" });
  await complete(cronker, "Ship it");
  await complete(web, "Launch the site");

  await page.goto(cronk.url);
  await page.getByLabel("Email").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("navigation").getByRole("link", { name: /^Inbox/ }).click();
  const items = page.getByRole("list", { name: "Inbox" }).getByRole("listitem");
  await expect(items).toHaveCount(4);
  return { items, completeInCronk: () => complete(cronker, "Another one") };
}

/** Toggles options of an Inbox filter, then closes its list. */
async function toggle(page: Page, label: string, ...options: string[]) {
  await page.getByRole("button", { name: new RegExp(`^Filter by ${label}`) }).click();
  const list = page.getByRole("listbox", { name: label });
  for (const option of options) await list.getByRole("option", { name: option, exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();
}

test("the Inbox filters by Project and kind, kept in the address, with the sidebar still counting everything", async ({ page, cronk }) => {
  const { items, completeInCronk } = await inboxOfTwoProjects(page, cronk);
  const inboxLink = page.getByRole("navigation").getByRole("link", { name: /^Inbox/ });
  await expect(page.getByText(/^Showing/)).toHaveCount(0);

  await toggle(page, "Project", "CRONK");
  await expect(items).toHaveCount(3);
  await expect(page.getByText("Showing 3 of 4")).toBeVisible();
  await expect(page).toHaveURL(/project=CRONK/);
  await expect(inboxLink).toHaveAccessibleName("Inbox, 4 waiting");

  await toggle(page, "Kind", "Unverified");
  await expect(items).toHaveCount(1);
  await expect(items.nth(0)).toContainText("CRONK-2");
  // The selected Question is filtered out, so the first shown item is selected.
  await expect(items.nth(0)).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("list", { name: "Inbox" })).toContainText("Unverified · 1");
  await expect(page).toHaveURL(/kind=unverified/);

  // A reload keeps the filters.
  await page.reload();
  await expect(items).toHaveCount(1);
  await expect(page.getByText("Showing 1 of 4")).toBeVisible();

  // Live: a new item in another Project doesn't join the filtered list, though the sidebar counts it.
  await toggle(page, "Project", "CRONK", "WEB");
  await expect(items).toHaveCount(1);
  await expect(items.nth(0)).toContainText("WEB-1");
  await completeInCronk();
  await expect(inboxLink).toHaveAccessibleName("Inbox, 5 waiting");
  await expect(page.getByText("Showing 1 of 5")).toBeVisible();
  await expect(items).toHaveCount(1);

  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(items).toHaveCount(5);
  await expect(page.getByText(/^Showing/)).toHaveCount(0);
  await expect(page).not.toHaveURL(/project=|kind=/);
});

test("a filter that matches nothing says so, apart from the empty Inbox, and a phone folds the filters into one button", async ({
  page,
  cronk,
}) => {
  const { items } = await inboxOfTwoProjects(page, cronk);
  await page.goto(`${page.url()}?kind=discovered`);
  await expect(page.getByText("Nothing here matches these filters.")).toBeVisible();
  await expect(page.getByText("Nothing is waiting on you.")).toHaveCount(0);
  await page.getByRole("button", { name: "Clear filters" }).first().click();
  await expect(items).toHaveCount(4);

  await page.setViewportSize({ width: 390, height: 800 });
  const project = page.getByRole("button", { name: /^Filter by Project/ });
  await expect(project).toBeHidden();
  const fold = page.getByRole("button", { name: "Filter", exact: true });
  await fold.click();
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await expect(project).toBeVisible();
  await toggle(page, "Kind", "Questions");
  await expect(items).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Filter · 1" })).toBeVisible();
});
