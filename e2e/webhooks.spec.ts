import { expect, test } from "./fixtures.js";
import { setUp, signIn } from "../test/harness/flows.js";

// A webhook's tries show in its delivery list, and one given up on marks it Failing until a delivery succeeds.
test("a webhook's failed tries show in its deliveries, and Failing shows until a delivery succeeds", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const [name, value] = cookie.split("=") as [string, string];
  await page.context().addCookies([{ name, value, url: cronk.url }]);
  const hooks = `/api/workspaces/${workspace.id}/webhooks`;
  const created = await cronk.request("POST", hooks, { cookie, body: { name: "Phone", url: cronk.webhooks.url } });
  const { id } = (await created.json()) as { id: string };

  // One test delivery fails every try for a day.
  cronk.webhooks.failNext(2, 500);
  expect((await cronk.request("POST", `${hooks}/${id}/test`, { cookie })).status).toBe(201);
  await cronk.deliverWebhooks();

  await page.goto(`${cronk.url}/account`);
  const block = page.getByRole("region", { name: "Webhook Phone" });
  const tries = block.getByRole("table", { name: "Last deliveries" }).getByRole("list", { name: "Tries" });
  await expect(tries.getByRole("listitem")).toHaveCount(1);
  await expect(tries).toContainText("500");
  await expect(block.getByText(/Next try at/)).toBeVisible();
  await expect(block.getByText("Failing")).toHaveCount(0);

  cronk.clock.advance(24 * 60 * 60_000);
  await cronk.deliverWebhooks();
  await page.reload();
  await expect(tries.getByRole("listitem")).toHaveCount(2);
  await expect(block.getByText("Gave up")).toBeVisible();
  await expect(block.getByText("Failing", { exact: true })).toBeVisible();

  // Send test, delivered, clears it.
  const queued = page.waitForResponse((r) => r.url().endsWith(`/webhooks/${id}/test`) && r.status() === 201);
  await block.getByRole("button", { name: "Send test" }).click();
  await queued;
  await cronk.deliverWebhooks();
  await page.reload();
  await expect(block.getByText("Failing", { exact: true })).toHaveCount(0);
});
