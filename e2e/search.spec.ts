import { setUp, signIn } from "../test/harness/flows.js";
import { expect, signInInBrowser, test } from "./fixtures.js";

test("search from the sidebar, see results grouped by kind with highlighted snippets, narrow by Project, and open one", async ({
  page,
  cronk,
}) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const post = async (path: string, body: unknown) => (await cronk.request("POST", path, { cookie, body })).json();
  const project = await post(`/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const website = await post(`/api/workspaces/${workspace.id}/projects`, { name: "Website", key: "WEB" });
  await post(`/api/projects/${project.id}/tickets`, {
    title: "Labels vanish",
    description: "Merging a branch loses its labels.",
  });
  await post(`/api/projects/${website.id}/tickets`, { title: "Merge the footers" });
  await post(`/api/workspaces/${workspace.id}/documents`, { title: "Releasing", body: "We merge to main, then tag." });
  await post(`/api/projects/${project.id}/terms`, { name: "Merge Step", definition: "Merges a Pull Request.", avoid: [] });

  await signInInBrowser(page, cronk);
  const box = page.getByRole("navigation", { name: "Sidebar" }).getByRole("searchbox", { name: "Search" });
  await box.fill("merged");
  await box.press("Enter");

  await expect(page.getByRole("heading", { name: "Search", level: 1 })).toBeVisible();
  await expect(page).toHaveURL(`${cronk.url}/adas-workspace/search?q=merged`);
  const results = page.getByRole("region", { name: "Search results" });
  await expect(results.getByRole("heading", { level: 2 })).toHaveText(["Tickets 2", "Documents 1", "Terms 1"]);
  const tickets = page.getByRole("region", { name: "Tickets" });
  const labelsVanish = tickets.getByRole("listitem").filter({ hasText: "Labels vanish" });
  await expect(labelsVanish.getByText("CRONK-1")).toBeVisible();
  await expect(labelsVanish.locator("mark")).toHaveText("Merging");
  await expect(page.getByRole("region", { name: "Documents" }).locator("mark")).toHaveText("merge");

  await page.getByLabel("Project").selectOption({ label: "CRONK Cronker" });
  await expect(page).toHaveURL(/\/search\?q=merged&project=/);
  await expect(results.getByRole("heading", { level: 2 })).toHaveText(["Tickets 1", "Terms 1"]);

  await page.getByRole("link", { name: /Labels vanish/ }).click();
  await expect(page.getByRole("heading", { name: "Labels vanish" })).toBeVisible();
  await expect(page).toHaveURL(`${cronk.url}/adas-workspace/tickets/CRONK-1`);
});
