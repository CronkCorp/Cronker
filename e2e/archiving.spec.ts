import { setUp, signIn } from "../test/harness/flows.js";
import { expect, signInInBrowser, test } from "./fixtures.js";

test("an Admin archives a Project from its menu: it moves to Archived, shows the banner and offers no changes, until unarchived", async ({
  page,
  cronk,
}) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const post = async (path: string, body: unknown) =>
    (await cronk.request("POST", path, { cookie, body })).json() as Promise<{ id: string }>;
  const project = await post(`/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  await post(`/api/projects/${project.id}/tickets`, { title: "Ship it" });

  await signInInBrowser(page, cronk);
  await page.goto(`${cronk.url}/projects/${project.id}`);
  await expect(page.getByRole("heading", { name: "Cronker" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New Ticket" })).toBeVisible();

  await page.getByRole("button", { name: "More of this Project" }).click();
  await page.getByRole("menuitem", { name: "Archive…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Archive" }).click();

  const banner = page.getByRole("note", { name: "Archived" });
  await expect(banner).toContainText("This Project is archived");
  await expect(page.getByRole("button", { name: "New Ticket" })).toHaveCount(0);
  const sidebar = page.getByRole("navigation", { name: "Sidebar" });
  const archived = sidebar.locator("details.sidebar-archived");
  await expect(archived.getByRole("link", { name: /CRONK/ })).toBeVisible();
  await expect(sidebar.getByText("None but archived ones.")).toBeVisible();

  await banner.getByRole("button", { name: "Unarchive" }).click();
  await expect(banner).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New Ticket" })).toBeVisible();
  await expect(archived).toHaveCount(0);
  await expect(sidebar.getByRole("link", { name: /CRONK/ })).toBeVisible();
});
