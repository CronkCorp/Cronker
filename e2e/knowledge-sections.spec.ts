import type { Page } from "@playwright/test";
import { addMember, setUp, signIn } from "../test/harness/flows.js";
import type { StartedCronk } from "../test/harness/start-cronk.js";
import { expect, signInInBrowser, test } from "./fixtures.js";

/** Ada's Workspace with the Project CRONK, a Document in its page tree and one in the Workspace's. */
async function withKnowledge(cronk: StartedCronk) {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const post = async (path: string, body: unknown) =>
    (await cronk.request("POST", path, { cookie, body })).json() as Promise<{ id: string }>;
  const project = await post(`/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  await post(`/api/projects/${project.id}/documents`, { title: "Plan", body: "Runs start from a Brief." });
  await post(`/api/workspaces/${workspace.id}/documents`, { title: "Handbook", body: "How we work." });
  /** The titles of a page tree's Documents, as the API lists them. */
  const titles = async (path: string) =>
    ((await (await cronk.request("GET", path, { cookie })).json()) as { title: string }[]).map((d) => d.title);
  return {
    workspace,
    project,
    cookie,
    projectTitles: () => titles(`/api/projects/${project.id}/documents`),
    workspaceTitles: () => titles(`/api/workspaces/${workspace.id}/documents`),
  };
}

/** Creates a Document from a section's own New Document dialog. */
async function createIn(page: Page, section: ReturnType<Page["getByRole"]>, title: string) {
  await section.getByRole("button", { name: "New Document" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Title").fill(title);
  await dialog.getByRole("button", { name: "Create Document" }).click();
  await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
}

test("Documents: a Project's page shows its page tree, then the Workspace's, each creating in its own tree", async ({ page, cronk }) => {
  const { project, projectTitles, workspaceTitles } = await withKnowledge(cronk);
  await signInInBrowser(page, cronk);
  await page.goto(`${cronk.url}/projects/${project.id}/documents`);
  await expect(page.getByRole("heading", { name: "Documents", level: 1 })).toBeVisible();

  const projectSection = page.getByRole("region", { name: "CRONK Cronker" });
  const workspaceSection = page.getByRole("region", { name: "Workspace", exact: true });
  await expect(page.getByRole("main").getByRole("heading", { level: 2 })).toHaveText(["CRONK Cronker", "Workspace"]);
  await expect(projectSection.getByRole("link", { name: /Plan/ })).toBeVisible();
  await expect(projectSection.getByRole("link", { name: /Handbook/ })).toHaveCount(0);
  await expect(workspaceSection.getByRole("link", { name: /Handbook/ })).toBeVisible();
  await expect(workspaceSection.getByRole("link", { name: /Plan/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Scope:/ })).toHaveCount(0);

  // New Document in the Project's section creates in its page tree.
  await createIn(page, projectSection, "Roadmap");
  expect(await projectTitles()).toContain("Roadmap");
  expect(await workspaceTitles()).not.toContain("Roadmap");

  // New Document in the Workspace's section creates in the Workspace's.
  await page.goto(`${cronk.url}/projects/${project.id}/documents`);
  await createIn(page, workspaceSection, "Onboarding");
  expect(await workspaceTitles()).toContain("Onboarding");
  expect(await projectTitles()).not.toContain("Onboarding");

  // A Workspace Document's list crumb leads to the active Project's Documents, which list it too.
  await page.getByRole("navigation", { name: "Breadcrumbs" }).getByRole("link", { name: "Documents" }).click();
  await expect(page).toHaveURL(/\/projects\/CRONK\/documents$/);
  await expect(workspaceSection.getByRole("link", { name: /Onboarding/ })).toBeVisible();
  await expect(projectSection.getByRole("link", { name: /Roadmap/ })).toBeVisible();

  // The Workspace's own page shows only its page tree.
  await page.goto(page.url().replace(/\/projects\/CRONK\/documents$/, "/documents"));
  await expect(page.getByRole("heading", { name: "Documents", level: 1 })).toBeVisible();
  await expect(workspaceSection.getByRole("link", { name: /Handbook/ })).toBeVisible();
  await expect(page.getByRole("main").getByRole("heading", { level: 2 })).toHaveText(["Workspace"]);
  await expect(projectSection).toHaveCount(0);
});

test("Documents: with Read in the Project, its section offers no New Document and shows the Read line; the Workspace's still does", async ({
  page,
  cronk,
}) => {
  const { workspace, project, cookie } = await withKnowledge(cronk);
  const grace = await addMember(cronk, cookie, workspace.id, "grace@example.com");
  const access = await cronk.request("PUT", `/api/projects/${project.id}/access`, {
    cookie,
    body: { visibility: "open", users: [{ userId: grace.user.id, level: "read" }] },
  });
  expect(access.status).toBe(200);

  await page.goto(cronk.url);
  await page.getByLabel("Email").fill("grace@example.com");
  await page.getByLabel("Password").fill(grace.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Sidebar" })).toBeVisible();
  await page.goto(`${cronk.url}/projects/${project.id}/documents`);

  const projectSection = page.getByRole("region", { name: "CRONK Cronker" });
  const workspaceSection = page.getByRole("region", { name: "Workspace", exact: true });
  await expect(projectSection.getByRole("link", { name: /Plan/ })).toBeVisible();
  await expect(projectSection.getByRole("note")).toHaveText("You have Read in this Project: you follow its work, but don't change it.");
  await expect(projectSection.getByRole("button", { name: "New Document" })).toHaveCount(0);
  await expect(workspaceSection.getByRole("note")).toHaveCount(0);
  await expect(workspaceSection.getByRole("button", { name: "New Document" })).toBeVisible();
});
