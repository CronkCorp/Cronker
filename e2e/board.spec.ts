import { setUp, signIn } from "../test/harness/flows.js";
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
