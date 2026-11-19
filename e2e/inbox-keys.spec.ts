import type { Page } from "@playwright/test";
import type { StartedCronk } from "../test/harness/start-cronk.js";
import { expect, test } from "./fixtures.js";

/**
 * Ada's Inbox with a Question and the Ticket its needs you Outcome handed back (CRONK-1), and an Unverified
 * completion (CRONK-2).
 */
async function inboxOfThree(page: Page, cronk: StartedCronk) {
  const credentials = { email: "ada@example.com", password: "correct horse battery" };
  const { workspace } = await (
    await cronk.request("POST", "/api/setup", { body: { ...credentials, setupCode: cronk.setupCode(), workspaceName: "Ada's Workspace" } })
  ).json();
  const cookie = (await cronk.request("POST", "/api/sign-in", { body: credentials })).headers.get("set-cookie")!.split(";")[0]!;
  const call = async (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
    (await cronk.request(method, path, headers ? { headers, body } : { cookie, body })).json();
  const project = await call("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id;
  const runner = await call("POST", "/api/runners", { name: "Fake", kind: "fake" });
  const agent = await call("POST", `/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
  await call("PATCH", `/api/agents/${agent.id}`, { runnerId: runner.id });
  const { secret } = await call("POST", `/api/agents/${agent.id}/tokens`, { name: "cloud", access: "full" });
  const finish = async (ticketId: string, body: object) => {
    const runs = await call("GET", `/api/tickets/${ticketId}/runs`);
    const running = runs.find((r: { state: string }) => r.state === "running");
    await call("POST", `/api/runs/${running.id}/finish`, body, { authorization: `Bearer ${secret}` });
  };
  const asked = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Pick a colour" });
  await call("PATCH", `/api/tickets/${asked.id}`, { delegateId: agent.id, statusId: status("Triage") });
  await finish(asked.id, { outcome: "needs you", question: "Blue or green?" });
  const completed = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Ship it" });
  await call("PATCH", `/api/tickets/${completed.id}`, { delegateId: agent.id, autonomousDelegation: true, statusId: status("Code review") });
  await finish(completed.id, { outcome: "complete" });

  await page.goto(cronk.url);
  await page.getByLabel("Email").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("navigation").getByRole("link", { name: /^Inbox/ }).click();
  const items = page.getByRole("list", { name: "Inbox" }).getByRole("listitem");
  await expect(items).toHaveCount(3);
  return { items, detail: page.getByRole("region", { name: "Selected item" }) };
}

test("J and K move through the Inbox, A focuses the answer box, C Accepts and R opens Reopen…, never while typing", async ({
  page,
  cronk,
}) => {
  const { items, detail } = await inboxOfThree(page, cronk);
  await expect(page.getByText("J / K move through the list")).toBeVisible();

  // Without a selection in the address, the first item is selected.
  await expect(items.nth(0)).toHaveAttribute("aria-current", "true");
  await expect(detail).toContainText("Blue or green?");
  await page.keyboard.press("j");
  await expect(items.nth(1)).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("k");
  await expect(items.nth(0)).toHaveAttribute("aria-current", "true");

  // A focuses the Question's answer box; typing there moves nothing.
  await page.keyboard.press("a");
  const answer = detail.getByLabel("Answer");
  await expect(answer).toBeFocused();
  await page.keyboard.type("jjk");
  await expect(answer).toHaveValue("jjk");
  await expect(items.nth(0)).toHaveAttribute("aria-current", "true");
  await answer.blur();

  // R opens Reopen… on the Unverified completion, C Accepts it.
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await expect(items.nth(2)).toHaveAttribute("aria-current", "true");
  await expect(detail).toContainText("CRONK-2 Ship it");
  await page.keyboard.press("r");
  await expect(page.getByRole("dialog").getByLabel("Why reopen it?")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.keyboard.press("c");

  // Acting on the last item selects the one before it.
  await expect(items).toHaveCount(2);
  await expect(items.nth(1)).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("navigation").getByRole("link", { name: /^Inbox/ })).toHaveAccessibleName("Inbox, 2 waiting");
});

test("the selected Inbox item is kept in the address, so a reload reopens it", async ({ page, cronk }) => {
  const { items, detail } = await inboxOfThree(page, cronk);
  await items.nth(2).getByRole("button").click();
  await expect(items.nth(2)).toHaveAttribute("aria-current", "true");
  await expect(page).toHaveURL(/[?&]item=/);
  await page.reload();
  await expect(items.nth(2)).toHaveAttribute("aria-current", "true");
  await expect(detail).toContainText("CRONK-2 Ship it");
});
