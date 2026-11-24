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

test("Terms: a Project's page shows its Terms, then the Workspace's; a replaced Workspace Term is marked, and New Term in each creates it there", async ({
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
  const workspaceSection = page.getByRole("main").getByRole("region", { name: "Workspace", exact: true });
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
  await page.getByRole("navigation", { name: "Breadcrumbs" }).getByRole("link", { name: "Terms" }).click();
  await expect(projectSection.getByRole("article", { name: "Brief" })).toBeVisible();
  await expect(workspaceSection.getByRole("article", { name: "Brief" })).toHaveCount(0);

  await newTerm(page, workspaceSection, "Outcome");
  await expect(page).toHaveURL(/\/adas-workspace\/glossary\/Outcome$/);
  // A Workspace Term's list crumb leads to the active Project's Terms, which show the Workspace's too.
  await page.getByRole("navigation", { name: "Breadcrumbs" }).getByRole("link", { name: "Terms" }).click();
  await expect(page).toHaveURL(/\/projects\/CRONK\/glossary$/);
  await expect(workspaceSection.getByRole("article", { name: "Outcome" })).toBeVisible();
  await expect(projectSection.getByRole("article", { name: "Outcome" })).toHaveCount(0);

  // The Workspace's own page shows only its section.
  await page.goto(`${cronk.url}/workspaces/${workspace.id}/glossary`);
  await expect(page.getByRole("main").getByRole("heading", { level: 2 })).toHaveText(["Workspace"]);
  await expect(page.getByRole("main").getByRole("region", { name: "Workspace", exact: true }).getByRole("article", { name: "Run" })).not.toContainText("Replaced in");
});

test("Terms: with Read in the Project, its section offers no New Term while the Workspace's still does", async ({ page, cronk }) => {
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
  await expect(page.getByRole("main").getByRole("region", { name: "Workspace", exact: true }).getByRole("button", { name: "New Term" })).toBeVisible();
});
