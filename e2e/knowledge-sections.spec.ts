import type { Page } from "@playwright/test";
import { addMember, setUp, signIn } from "../test/harness/flows.js";
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

/** Creates a Term through New Term in a section, landing on its page. */
async function newTerm(page: Page, section: ReturnType<Page["getByRole"]>, name: string) {
  await section.getByRole("button", { name: "New Term" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByRole("button", { name: "Create Term" }).click();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
}

test("Terms show the Project's section, then the Workspace's, a replaced Workspace Term marked, and New Term in each creates it there", async ({
  page,
  cronk,
}) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const post = async (path: string, body: unknown) => (await cronk.request("POST", path, { cookie, body })).json() as Promise<{ id: string }>;
  const project = await post(`/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  await post(`/api/workspaces/${workspace.id}/terms`, { name: "Run", definition: "One go of an Agent.", avoid: [] });
  await post(`/api/workspaces/${workspace.id}/terms`, { name: "Ticket", definition: "A piece of work.", avoid: ["issue"] });
  await post(`/api/projects/${project.id}/terms`, { name: "Run", definition: "One go of an Agent on a Ticket.", avoid: [] });

  await signInInBrowser(page, cronk);
  await page.goto(`${cronk.url}/projects/${project.id}/glossary`);
  await expect(page).toHaveURL(/\/projects\/CRONK\/glossary$/);
  await expect(page.getByRole("main").getByRole("heading", { level: 2 })).toHaveText(["CRONK Cronker", "Workspace"]);
  await expect(page.getByRole("button", { name: /^Scope:/ })).toHaveCount(0);

  const projectSection = page.getByRole("main").getByRole("region", { name: "CRONK Cronker" });
  const workspaceSection = page.getByRole("main").getByRole("region", { name: "Workspace" });
  const projectRun = projectSection.getByRole("article", { name: "Run" });
  await expect(projectRun).toContainText("Overrides the Workspace Term");
  const workspaceRun = workspaceSection.getByRole("article", { name: "Run" });
  await expect(workspaceRun).toContainText("Replaced in CRONK");
  await expect(workspaceRun).toHaveClass(/\breplaced\b/);
  const workspaceTicket = workspaceSection.getByRole("article", { name: "Ticket" });
  await expect(workspaceTicket).not.toContainText("Replaced in");
  await expect(workspaceTicket).not.toHaveClass(/\breplaced\b/);

  // One filter box filters both sections.
  await page.getByLabel("Filter Terms").fill("issue");
  await expect(projectSection.getByRole("article")).toHaveCount(0);
  await expect(projectSection).toContainText("No Term matches “issue”.");
  await expect(workspaceSection.getByRole("article")).toHaveText([/Ticket/]);
  await page.getByLabel("Filter Terms").fill("");

  // New Term in the Project's section creates a Project Term; in the Workspace's, a Workspace Term.
  await newTerm(page, projectSection, "Brief");
  await expect(page).toHaveURL(/\/projects\/CRONK\/glossary\/Brief$/);
  await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Terms" }).click();
  await expect(projectSection.getByRole("article", { name: "Brief" })).toBeVisible();
  await expect(workspaceSection.getByRole("article", { name: "Brief" })).toHaveCount(0);

  await newTerm(page, workspaceSection, "Outcome");
  await expect(page).toHaveURL(/\/adas-workspace\/glossary\/Outcome$/);
  // A Workspace Term's list crumb leads to the active Project's Terms, which show the Workspace's too.
  await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Terms" }).click();
  await expect(page).toHaveURL(/\/projects\/CRONK\/glossary$/);
  await expect(workspaceSection.getByRole("article", { name: "Outcome" })).toBeVisible();
  await expect(projectSection.getByRole("article", { name: "Outcome" })).toHaveCount(0);

  // The Workspace's own page shows only its section.
  await page.goto(`${cronk.url}/workspaces/${workspace.id}/glossary`);
  await expect(page.getByRole("main").getByRole("heading", { level: 2 })).toHaveText(["Workspace"]);
  await expect(page.getByRole("main").getByRole("region", { name: "Workspace" }).getByRole("article", { name: "Run" })).not.toContainText("Replaced in");
});

test("with Read in the Project, its Terms section offers no New Term while the Workspace's still does", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const grace = await addMember(cronk, cookie, workspace.id, "grace@example.com");
  const created = await cronk.request("POST", `/api/workspaces/${workspace.id}/projects`, { cookie, body: { name: "Cronker", key: "CRONK" } });
  const project = (await created.json()) as { id: string };
  const access = await cronk.request("PUT", `/api/projects/${project.id}/access`, {
    cookie,
    body: { visibility: "private", users: [{ userId: grace.user.id, level: "read" }] },
  });
  expect(access.ok).toBe(true);

  await signInAs(page, cronk.url, "grace@example.com", grace.password);
  await page.goto(`${cronk.url}/projects/${project.id}/glossary`);
  await expect(page).toHaveURL(/\/projects\/CRONK\/glossary$/);
  await expect(page.getByRole("note")).toHaveText("You have Read in this Project: you follow its work, but don't change it.");
  await expect(page.getByRole("main").getByRole("region", { name: "CRONK Cronker" }).getByRole("button", { name: "New Term" })).toHaveCount(0);
  await expect(page.getByRole("main").getByRole("region", { name: "Workspace" }).getByRole("button", { name: "New Term" })).toBeVisible();
});
