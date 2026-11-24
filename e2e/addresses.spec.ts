import type { StartedCronk } from "../test/harness/start-cronk.js";
import { expect, signInInBrowser, test } from "./fixtures.js";
import { setUp, signIn } from "../test/harness/flows.js";

/** Ada's Workspace (`adas-workspace`) with a Project RP and its Ticket RP-1, set up through the API. */
async function withTicket(cronk: StartedCronk) {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const post = async (path: string, body: unknown) => (await cronk.request("POST", path, { cookie, body })).json();
  const project = await post(`/api/workspaces/${workspace.id}/projects`, { name: "Roadmap", key: "RP" });
  const ticket = await post(`/api/projects/${project.id}/tickets`, { title: "Readable addresses", description: "See RP-2." });
  const other = await post(`/api/projects/${project.id}/tickets`, { title: "Old links" });
  return { workspace, project, ticket, other, post };
}

test("a Ticket opens at its key's address, any letter case leading to the canonical one, and its links use keys", async ({ page, cronk }) => {
  await withTicket(cronk);
  await signInInBrowser(page, cronk);

  await page.getByRole("navigation", { name: "Sidebar" }).getByRole("link", { name: "Tickets" }).click();
  await expect(page).toHaveURL(`${cronk.url}/adas-workspace/projects/RP`);
  await page.getByRole("link", { name: /RP-1 Readable addresses/ }).click();
  await expect(page).toHaveURL(`${cronk.url}/adas-workspace/tickets/RP-1`);
  await page.getByRole("link", { name: "RP-2", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Old links" })).toBeVisible();
  await expect(page).toHaveURL(`${cronk.url}/adas-workspace/tickets/RP-2`);

  await page.goto(`${cronk.url}/ADAS-Workspace/tickets/rp-1`);
  await expect(page.getByRole("heading", { name: "Readable addresses" })).toBeVisible();
  await expect(page).toHaveURL(`${cronk.url}/adas-workspace/tickets/RP-1`);
  await page.goto(`${cronk.url}/adas-workspace/projects/rp/list`);
  await expect(page).toHaveURL(`${cronk.url}/adas-workspace/projects/RP/list`);
});
