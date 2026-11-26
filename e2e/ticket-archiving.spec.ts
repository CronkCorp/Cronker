import { setUp, signIn } from "../test/harness/flows.js";
import { expect, pickFilter, signInInBrowser, test } from "./fixtures.js";

test("a User archives a Done Ticket from its page: it leaves the board and the List until shown or unarchived", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const send = async (method: string, path: string, body?: unknown) =>
    (await cronk.request(method, path, { cookie, body })).json() as Promise<{ id: string; statuses: { id: string; name: string }[] }>;
  const project = await send("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const ticket = await send("POST", `/api/projects/${project.id}/tickets`, { title: "Ship the board" });
  await send("POST", `/api/projects/${project.id}/tickets`, { title: "Keep going" });
  const done = project.statuses.find((s) => s.name === "Done")!.id;
  await send("PATCH", `/api/tickets/${ticket.id}`, { statusId: done });

  await signInInBrowser(page, cronk);
  await page.goto(`${cronk.url}/adas-workspace/tickets/CRONK-1`);
  await page.getByRole("button", { name: "Archive" }).click();

  const banner = page.getByRole("note", { name: "Archived" });
  await expect(banner).toContainText("This Ticket is archived");
  await expect(page.getByRole("button", { name: "Archive", exact: true })).toHaveCount(0);

  await page.goto(`${cronk.url}/projects/${project.id}`);
  const board = page.getByRole("region", { name: "Board" });
  await expect(board.getByText("Keep going")).toBeVisible();
  await expect(board.getByText("Ship the board")).toHaveCount(0);

  await page.goto(`${cronk.url}/projects/${project.id}/list`);
  const list = page.getByRole("region", { name: "List" });
  await expect(list.getByText("Keep going")).toBeVisible();
  await expect(list.getByText("Ship the board")).toHaveCount(0);
  await pickFilter(page, "Archived", "Archived too");
  await expect(list.getByRole("link", { name: /Ship the board/ })).toContainText("Archived");

  await list.getByRole("link", { name: /Ship the board/ }).click();
  await banner.getByRole("button", { name: "Unarchive" }).click();
  await expect(banner).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Archive" })).toBeVisible();
});
