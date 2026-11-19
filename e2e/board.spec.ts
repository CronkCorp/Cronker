import { setUp, signIn } from "../test/harness/flows.js";
import type { Locator } from "@playwright/test";
import { expect, test } from "./fixtures.js";

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

test("a 1280px screen shows every Status of the board, named in full, without sideways scrolling", async ({ page, cronk }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const project = await (
    await cronk.request("POST", `/api/workspaces/${workspace.id}/projects`, { cookie, body: { name: "Cronker", key: "CRONK" } })
  ).json();

  await page.goto(cronk.url);
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: "CRONK Cronker" }).click();
  const board = page.getByRole("region", { name: "Board" });
  await expect(board.getByRole("region", { name: "Backlog", exact: true })).toBeVisible();

  // The default board's nine Statuses, Done and Canceled collapsed to their dot and count.
  const open = ["Backlog", "Triage", "Ready", "Investigate", "Implement", "Code review", "In Review"];
  for (const name of [...open, "Done", "Canceled"]) {
    const column = board.getByRole("region", { name, exact: true });
    const box = (await column.boundingBox())!;
    expect(box.x + box.width, `${name} ends inside the screen`).toBeLessThanOrEqual(1280);
  }
  // Each open column's name, and its Step's model label, are shown whole rather than cut off.
  const models: Record<string, string> = { Triage: "haiku", Investigate: "sonnet", Implement: "opus", "Code review": "sonnet" };
  const whole = (shown: Locator) => shown.evaluate((e) => e.scrollWidth <= e.clientWidth);
  for (const name of open) {
    const column = board.getByRole("region", { name, exact: true });
    const head = column.getByRole("heading", { name });
    await expect(head).toBeVisible();
    expect(await whole(head), `${name} is named in full`).toBe(true);
    const model = models[name];
    if (model) expect(await whole(column.getByText(model, { exact: true })), `${name}'s ${model} is shown in full`).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);
});
