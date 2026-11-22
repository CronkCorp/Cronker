import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { addMember, createGitHubApp, setUp, signIn } from "../test/harness/flows.js";
import type { StartedCronk } from "../test/harness/start-cronk.js";

// docs/ui.md: every settings page is one layout, a list of its sections beside them, and stays open after saving.

/** Ada set up and signed in, with a Project; returns the Workspace and the Project. */
async function signedIn(page: Page, cronk: StartedCronk) {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const created = await cronk.request("POST", `/api/workspaces/${workspace.id}/projects`, { cookie, body: { name: "Cronker", key: "CRONK" } });
  const project = (await created.json()) as { id: string };
  await page.goto(cronk.url);
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Ada's Workspace" })).toBeVisible();
  return { workspace, project };
}

const sections = (page: Page) => page.getByRole("navigation", { name: "Settings sections" });

test("Project settings list their sections, and a section's link brings it into view", async ({ page, cronk }) => {
  const { project } = await signedIn(page, cronk);
  await page.setViewportSize({ width: 1280, height: 700 });
  await page.goto(`${cronk.url}/projects/${project.id}/settings`);

  await expect(sections(page).getByRole("link")).toHaveText([
    "Statuses and Steps",
    "Access",
    "Delegation defaults",
    "Repositories",
    "Pull Request automation",
    "Merges by agents",
  ]);
  await expect(sections(page).getByRole("link", { name: "Statuses and Steps" })).toHaveAttribute("aria-current", "true");

  const automation = page.getByRole("region", { name: "Pull Request automation" });
  await expect(automation).not.toBeInViewport();
  await sections(page).getByRole("link", { name: "Pull Request automation" }).click();
  await expect(automation).toBeInViewport();
  await expect(sections(page).getByRole("link", { name: "Pull Request automation" })).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("heading", { name: "Project settings", level: 1 })).toBeVisible();
});

test("Project settings say Saved. after each change and stay open", async ({ page, cronk }) => {
  const { project } = await signedIn(page, cronk);
  await page.goto(`${cronk.url}/projects/${project.id}/settings`);

  const delegation = page.getByRole("region", { name: "Delegation defaults" });
  await expect(delegation.getByRole("status")).toHaveCount(0);
  await delegation.getByLabel("New Tickets start delegated to their creator's Agent").click();
  await expect(delegation.getByRole("status")).toHaveText("Saved.");
  await expect(delegation.getByLabel("New Tickets start delegated to their creator's Agent")).toBeChecked();

  const automation = page.getByRole("region", { name: "Pull Request automation" });
  await automation.getByLabel("Merges complete their Tickets").click();
  await expect(automation.getByRole("status")).toHaveText("Saved.");

  const statuses = page.getByRole("region", { name: "Statuses", exact: true });
  await statuses.getByLabel("New Status name").fill("Design");
  await statuses.getByRole("button", { name: "Add Status" }).click();
  await expect(statuses.getByRole("status")).toHaveText("Saved.");
  await expect(statuses.getByLabel("Name of Design")).toBeVisible();

  // A refusal says why instead.
  await statuses.getByLabel("Name of Design").fill("Backlog");
  await statuses.getByRole("button", { name: "Rename Design" }).click();
  await expect(statuses.getByRole("alert")).toBeVisible();
  await expect(statuses.getByRole("status")).toHaveCount(0);

  await expect(page.getByRole("heading", { name: "Project settings", level: 1 })).toBeVisible();
});

test("an Admin lets agents merge; a member who isn't one sees the setting but can't change it", async ({ page, cronk }) => {
  const { workspace, project } = await signedIn(page, cronk);
  await page.goto(`${cronk.url}/projects/${project.id}/settings`);

  const merges = page.getByRole("region", { name: "Merges by agents" });
  const setting = merges.getByLabel("Agents may merge Autonomous Delegation Tickets' Pull Requests");
  await expect(setting).not.toBeChecked();
  await setting.click();
  await expect(merges.getByRole("status")).toHaveText("Saved.");
  await expect(setting).toBeChecked();

  const bea = await addMember(cronk, await signIn(cronk), workspace.id, "bea@example.com");
  await page.context().clearCookies();
  await page.goto(cronk.url);
  await page.getByLabel("Email").fill("bea@example.com");
  await page.getByLabel("Password").fill(bea.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Sidebar" })).toBeVisible();
  await page.goto(`${cronk.url}/projects/${project.id}/settings`);
  await expect(setting).toBeChecked();
  await expect(setting).toBeDisabled();
  await expect(merges).toContainText("Only an Admin of this Workspace changes this.");
});

test("an Admin makes a Project private and lists Users on it; others lose sight of it and its blockers", async ({
  page,
  cronk,
}) => {
  const { workspace, project } = await signedIn(page, cronk);
  const adaCookie = await signIn(cronk);
  const bea = await addMember(cronk, adaCookie, workspace.id, "bea@example.com");
  const cal = await addMember(cronk, adaCookie, workspace.id, "cal@example.com");
  const call = async (path: string, body: unknown) =>
    (await cronk.request("POST", path, { cookie: adaCookie, body })).json() as Promise<{ id: string }>;
  const website = await call(`/api/workspaces/${workspace.id}/projects`, { name: "Website", key: "WEB" });
  const plans = await call(`/api/projects/${project.id}/tickets`, { title: "Secret plans" });
  const landing = await call(`/api/projects/${website.id}/tickets`, { title: "Landing page" });
  await call(`/api/tickets/${plans.id}/relations`, { kind: "blocks", ticketId: landing.id });
  await page.goto(`${cronk.url}/projects/${project.id}/settings`);

  const access = page.getByRole("region", { name: "Access" });
  await access.getByLabel("Private to the Users listed below").click();
  await expect(access.getByLabel("Private to the Users listed below")).toBeChecked();
  await expect(access.getByRole("status")).toHaveText("Saved.");
  await access.getByLabel(/^bea@example\.com/).click();
  await expect(access.getByLabel(/^bea@example\.com/)).toBeChecked();
  await expect(access.getByLabel(/^ada@example\.com/)).toBeDisabled();

  const signInAs = async (email: string, password: string) => {
    await page.context().clearCookies();
    await page.goto(cronk.url);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("navigation", { name: "Sidebar" })).toBeVisible();
  };
  // Bea, listed, still finds it, and sees it is private without being able to change it.
  await signInAs("bea@example.com", bea.password);
  await expect(page.getByRole("navigation", { name: "Sidebar" }).getByRole("link", { name: /CRONK/ })).toBeVisible();
  await page.goto(`${cronk.url}/projects/${project.id}/settings`);
  await expect(page.getByRole("region", { name: "Access" })).toContainText("This Project is private");

  // Cal, unlisted, finds nothing of it, and WEB-1's chip counts its blocker without naming it.
  await signInAs("cal@example.com", cal.password);
  await expect(page.getByRole("navigation", { name: "Sidebar" }).getByRole("link", { name: /WEB/ })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Sidebar" }).getByRole("link", { name: /CRONK/ })).toHaveCount(0);
  await page.goto(`${cronk.url}/projects/${website.id}`);
  const chip = page.getByRole("button", { name: /^Blocked by/ });
  await expect(chip).toHaveText("Blocked by 1");
  await expect(chip).toHaveAccessibleName("Blocked by 1: a Ticket you can't see");
});

test("saving a Step says Saved. beside its buttons", async ({ page, cronk }) => {
  const { project } = await signedIn(page, cronk);
  await page.goto(`${cronk.url}/projects/${project.id}/settings`);

  const steps = page.getByRole("region", { name: "Steps" });
  await steps.locator("summary").filter({ hasText: "Backlog" }).click();
  await steps.getByRole("button", { name: "Add a Step to Backlog" }).click();
  await steps.getByLabel("Brief for Backlog").fill("Groom it.");
  await steps.getByRole("button", { name: "Save the Step on Backlog" }).click();
  await expect(steps.getByRole("status")).toHaveText("Saved.");
  await expect(steps.getByRole("button", { name: "Remove the Step from Backlog" })).toBeVisible();
});

test("adding and removing a Repository says Saved.", async ({ page, cronk }) => {
  const { project } = await signedIn(page, cronk);
  const cookie = await signIn(cronk);
  cronk.github.signedInAs = cronk.github.account("ada-gh");
  await createGitHubApp(cronk, cookie);
  cronk.github.install(cronk.github.apps[0]!, "cronkcorp", ["cronker"]);
  await page.goto(`${cronk.url}/projects/${project.id}/settings`);

  const repositories = page.getByRole("region", { name: "Repositories" });
  await repositories.getByRole("button", { name: "Add Repository" }).click();
  await page.getByRole("listbox", { name: "Repository to add" }).getByRole("option", { name: "cronkcorp/cronker" }).click();
  await expect(repositories.getByRole("status")).toHaveText("Saved.");
  await repositories.getByRole("button", { name: "Remove cronkcorp/cronker" }).click();
  await expect(repositories.getByText("The Project lists no Repositories yet.")).toBeVisible();
  await expect(repositories.getByRole("status")).toHaveText("Saved.");
});

test("Workspace settings, Members and the GitHub page share the settings layout", async ({ page, cronk }) => {
  const { workspace } = await signedIn(page, cronk);
  const cookie = await signIn(cronk);
  cronk.github.signedInAs = cronk.github.account("ada-gh");
  await createGitHubApp(cronk, cookie);
  await addMember(cronk, cookie, workspace.id, "cy@example.com");

  await page.goto(`${cronk.url}/workspaces/${workspace.id}/settings`);
  await expect(sections(page).getByRole("link")).toHaveText(["Name", "Model ids", "Lost Runs"]);
  await page.getByLabel("Lost-Run threshold (minutes)").fill("45");
  await page.getByRole("button", { name: "Save threshold" }).click();
  await expect(page.getByRole("region", { name: "Lost Runs" }).getByRole("status")).toHaveText("Saved.");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();

  await page.goto(`${cronk.url}/workspaces/${workspace.id}/members`);
  await expect(sections(page).getByRole("link")).toHaveText(["Add a member", "Members"]);
  await page.getByLabel("Email").fill("bea@example.com");
  await page.getByRole("button", { name: "Add by email" }).click();
  await expect(sections(page).getByRole("link")).toHaveText(["Add a member", "Added, not joined yet", "Members"]);
  const members = page.getByRole("region", { name: "Members", exact: true });
  await expect(members.getByRole("status")).toHaveCount(0);
  const cy = members.getByRole("row").filter({ hasText: "cy@example.com" });
  await cy.getByRole("button", { name: "Make Admin" }).click();
  await expect(members.getByRole("status")).toHaveText("Saved.");
  await expect(cy.getByRole("button", { name: "Remove Admin" })).toBeVisible();

  await page.goto(`${cronk.url}/github`);
  await expect(sections(page).getByRole("link")).toHaveText(["The App", "What the App needs", "Installations"]);
  // A page too short to scroll marks its first section until another is picked.
  await expect(sections(page).getByRole("link", { name: "The App", exact: true })).toHaveAttribute("aria-current", "true");
  await sections(page).getByRole("link", { name: "Installations" }).click();
  await expect(sections(page).getByRole("link", { name: "Installations" })).toHaveAttribute("aria-current", "true");
  await expect(sections(page).getByRole("link", { name: "The App", exact: true })).not.toHaveAttribute("aria-current", "true");
});

test("an Admin changes the model id a label stands for, and adds a label", async ({ page, cronk }) => {
  const { workspace } = await signedIn(page, cronk);

  await page.goto(`${cronk.url}/workspaces/${workspace.id}/settings`);
  const modelIds = page.getByRole("region", { name: "Model ids" });
  await expect(modelIds.getByRole("group", { name: "Model id of opus" }).getByLabel("Model id")).toHaveValue("claude-opus-5-5");
  await modelIds.getByRole("group", { name: "Model id of opus" }).getByLabel("Model id").fill("claude-opus-6");
  await modelIds.getByRole("button", { name: "Add a model label" }).click();
  const added = modelIds.getByRole("group", { name: "Model id of a new label" });
  await added.getByLabel("Model label").fill("fast");
  await modelIds.getByRole("group", { name: "Model id of fast" }).getByLabel("Model id").fill("claude-haiku-5-5");
  await modelIds.getByRole("button", { name: "Save model ids" }).click();
  await expect(modelIds.getByRole("status")).toHaveText("Saved.");

  await page.reload();
  await expect(modelIds.getByRole("group", { name: "Model id of opus" }).getByLabel("Model id")).toHaveValue("claude-opus-6");
  await expect(modelIds.getByRole("group", { name: "Model id of fast" }).getByLabel("Model id")).toHaveValue("claude-haiku-5-5");
});
