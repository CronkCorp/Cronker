import type { Page } from "@playwright/test";
import { addMember, setUp, signIn } from "../test/harness/flows.js";
import type { StartedCronk } from "../test/harness/start-cronk.js";
import { expect, signInInBrowser, test } from "./fixtures.js";

/** Signs the page in as another User, as they would at the sign-in page. */
async function signInAs(page: Page, url: string, email: string, password: string) {
  await page.context().clearCookies();
  await page.goto(url);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Sidebar" })).toBeVisible();
}

/** A Workspace with the Project CRONK, each with a proposed and an accepted Decision. */
async function withDecisions(cronk: StartedCronk) {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const post = async (path: string, body: unknown) =>
    (await cronk.request("POST", path, { cookie, body })).json() as Promise<{ id: string; version: { number: number } }>;
  const accept = (decision: { id: string; version: { number: number } }) =>
    cronk.request("PATCH", `/api/decisions/${decision.id}`, { cookie, body: { baseVersion: decision.version.number, status: "accepted" } });
  const project = await post(`/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  await post(`/api/projects/${project.id}/decisions`, { title: "Use Postgres", body: "" });
  await accept(await post(`/api/projects/${project.id}/decisions`, { title: "Keep it simple", body: "" }));
  await post(`/api/workspaces/${workspace.id}/decisions`, { title: "Ship weekly", body: "" });
  await accept(await post(`/api/workspaces/${workspace.id}/decisions`, { title: "Write it down", body: "" }));
  return { workspace, project, cookie };
}

test("a Project's Decisions show its register, then the Workspace's, and the status chips filter both", async ({ page, cronk }) => {
  const { workspace, project } = await withDecisions(cronk);
  await signInInBrowser(page, cronk);
  await page.goto(`${cronk.url}/projects/${project.id}/decisions`);
  await expect(page).toHaveURL(/\/projects\/CRONK\/decisions$/);
  await expect(page.getByRole("heading", { name: "Decisions", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Scope/ })).toHaveCount(0);

  const own = page.getByRole("region", { name: "CRONK Cronker" });
  const workspaces = page.getByRole("region", { name: "Workspace", exact: true });
  await expect(page.getByRole("main").getByRole("heading", { level: 2 })).toHaveText(["CRONK Cronker", "Workspace"]);
  await expect(own.getByRole("link", { name: "Use Postgres" })).toBeVisible();
  await expect(own.getByRole("link", { name: "Keep it simple" })).toBeVisible();
  await expect(workspaces.getByRole("link", { name: "Ship weekly" })).toBeVisible();
  await expect(workspaces.getByRole("link", { name: "Write it down" })).toBeVisible();
  for (const section of [own, workspaces]) {
    await expect(section.getByRole("button", { name: "New Decision" })).toBeVisible();
    await expect(section.getByRole("link", { name: "Export" })).toBeVisible();
    await expect(section.getByRole("button", { name: "Accept" })).toHaveCount(1);
  }

  // The chips count across both registers, and filter both.
  const chips = page.getByRole("group", { name: "Filter by status" });
  await expect(chips.getByRole("button", { name: "All 4" })).toBeVisible();
  await chips.getByRole("button", { name: "Accepted 2" }).click();
  await expect(own.getByRole("link", { name: "Use Postgres" })).toHaveCount(0);
  await expect(own.getByRole("link", { name: "Keep it simple" })).toBeVisible();
  await expect(workspaces.getByRole("link", { name: "Ship weekly" })).toHaveCount(0);
  await expect(workspaces.getByRole("link", { name: "Write it down" })).toBeVisible();

  // A Workspace Decision's list crumb leads back to the active Project's page.
  await workspaces.getByRole("link", { name: "Write it down" }).click();
  await expect(page.getByRole("heading", { name: "Write it down", level: 1 })).toBeVisible();
  await page.getByRole("navigation", { name: "Breadcrumbs" }).getByRole("link", { name: "Decisions" }).click();
  await expect(page).toHaveURL(/\/projects\/CRONK\/decisions$/);

  // The Workspace's own page shows its register alone.
  await page.goto(`${cronk.url}/workspaces/${workspace.id}/decisions`);
  await expect(page.getByRole("main").getByRole("heading", { level: 2 })).toHaveText(["Workspace"]);
  await expect(page.getByRole("link", { name: "Ship weekly" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Use Postgres" })).toHaveCount(0);
});

test("with Read in the Project, its register offers no New Decision, Accept or Reject, while the Workspace's still does", async ({
  page,
  cronk,
}) => {
  const { workspace, project, cookie } = await withDecisions(cronk);
  const grace = await addMember(cronk, cookie, workspace.id, "grace@example.com");
  const listed = await cronk.request("PUT", `/api/projects/${project.id}/access`, {
    cookie,
    body: { visibility: "open", users: [{ userId: grace.user.id, level: "read" }] },
  });
  expect(listed.status).toBe(200);

  await signInAs(page, cronk.url, "grace@example.com", grace.password);
  await page.goto(`${cronk.url}/projects/${project.id}/decisions`);
  const own = page.getByRole("region", { name: "CRONK Cronker" });
  const workspaces = page.getByRole("region", { name: "Workspace", exact: true });
  await expect(own.getByRole("link", { name: "Use Postgres" })).toBeVisible();
  await expect(own.getByRole("note")).toHaveText("You have Read in this Project: you follow its work, but don't change it.");
  await expect(own.getByRole("button", { name: "New Decision" })).toHaveCount(0);
  await expect(own.getByRole("button", { name: /^(Accept|Reject)$/ })).toHaveCount(0);
  await expect(workspaces.getByRole("link", { name: "Ship weekly" })).toBeVisible();
  await expect(workspaces.getByRole("button", { name: "New Decision" })).toBeVisible();
  await expect(workspaces.getByRole("button", { name: "Accept" })).toHaveCount(1);
});
