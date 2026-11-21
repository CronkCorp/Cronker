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

  await page.getByRole("link", { name: /RP Roadmap/ }).click();
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

test("old id addresses still open their pages, replaced by the readable ones", async ({ page, cronk }) => {
  const { workspace, project, ticket, post } = await withTicket(cronk);
  const decision = await post(`/api/projects/${project.id}/decisions`, { title: "Keys never change" });
  const term = await post(`/api/workspaces/${workspace.id}/terms`, { name: "Workspace slug", definition: "Its name in addresses." });
  const document = await post(`/api/projects/${project.id}/documents`, { title: "Onboarding", body: "Hello" });
  await signInInBrowser(page, cronk);

  for (const [old, readable, heading] of [
    [`/tickets/${ticket.id}`, "/adas-workspace/tickets/RP-1", "RP-1 Readable addresses"],
    [`/projects/${project.id}/list`, "/adas-workspace/projects/RP/list", "Roadmap"],
    [`/decisions/${decision.id}`, "/adas-workspace/projects/RP/decisions/1", "Keys never change"],
    [`/terms/${term.id}`, "/adas-workspace/glossary/Workspace%20slug", "Workspace slug"],
    [`/documents/${document.id}`, `/adas-workspace/documents/onboarding-${document.id.slice(0, 8)}`, "Onboarding"],
    [`/workspaces/${workspace.id}/decisions`, "/adas-workspace/decisions", "Decisions"],
  ] as const) {
    await page.goto(`${cronk.url}/adas-workspace/inbox`);
    await page.goto(`${cronk.url}${old}`);
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expect(page).toHaveURL(`${cronk.url}${readable}`);
    // Replaced, not pushed: going back leaves the page rather than landing on the old address again.
    await page.goBack();
    await expect(page).toHaveURL(`${cronk.url}/adas-workspace/inbox`);
  }
});

test("a Document's address with a stale slug leads to its current one, and follows a rename", async ({ page, cronk }) => {
  const { project, post } = await withTicket(cronk);
  const document = await post(`/api/projects/${project.id}/documents`, { title: "Onboarding", body: "Hello" });
  const short = document.id.slice(0, 8);
  await signInInBrowser(page, cronk);

  await page.goto(`${cronk.url}/adas-workspace/documents/an-old-title-${short}`);
  await expect(page.getByRole("heading", { name: "Onboarding" })).toBeVisible();
  await expect(page).toHaveURL(`${cronk.url}/adas-workspace/documents/onboarding-${short}`);

  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Title").fill("First day");
  await page.getByRole("button", { name: "Save as Version 2" }).click();
  await expect(page.getByRole("heading", { name: "First day" })).toBeVisible();
  await expect(page).toHaveURL(`${cronk.url}/adas-workspace/documents/first-day-${short}`);
});
