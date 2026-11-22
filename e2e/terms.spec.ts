import type { Page } from "@playwright/test";
import { addMember, firstUser, setUp, signIn } from "../test/harness/flows.js";
import type { StartedCronk } from "../test/harness/start-cronk.js";
import { expect, test } from "./fixtures.js";

test("create Workspace and Project Terms, see the Project's glossary replace same-named ones, edit and delete a Term", async ({
  page,
  cronk,
}) => {
  await cronk.request("POST", "/api/setup", {
    body: {
      setupCode: cronk.setupCode(),
      email: "ada@example.com",
      password: "correct horse battery",
      workspaceName: "Ada's Workspace",
    },
  });
  await page.goto(cronk.url);
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("Project name").fill("Cronker");
  await page.getByLabel("Key").fill("CRONK");
  await page.getByRole("button", { name: "Create Project" }).click();
  await expect(page.getByRole("heading", { name: "Cronker" })).toBeVisible();
  const projectUrl = page.url();

  // On a Project's page the sidebar leads to the Project's Terms; the scope switch leads to the Workspace's.
  await page.getByRole("navigation", { name: "Sidebar" }).getByRole("link", { name: "Terms" }).click();
  await expect(page).toHaveURL(/\/projects\/[^/]+\/glossary$/);
  await page.getByRole("button", { name: "Scope: CRONK Cronker" }).click();
  await page.getByRole("menuitemradio", { name: "Workspace" }).click();
  await expect(page.getByRole("heading", { name: "Terms", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Scope: Workspace" }).click();
  await expect(page.getByRole("menuitemradio", { name: "Workspace" })).toBeChecked();
  await page.keyboard.press("Escape");
  for (const [name, definition, avoid] of [
    ["Ticket", "A unit of work tracked within a Project.", "Issue, task"],
    ["Run", "One agent execution Cronk starts for one Ticket.", "job"],
  ]) {
    await page.getByRole("button", { name: "New Term" }).click();
    await page.getByRole("dialog").getByLabel("Name").fill(name!);
    await page.getByRole("textbox", { name: "Definition", exact: true }).fill(definition!);
    await page.getByLabel("Words to avoid").fill(avoid!);
    await page.getByRole("button", { name: "Create Term" }).click();
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    await page.goBack();
  }
  const glossary = page.getByRole("region", { name: "Glossary" });
  await expect(glossary.getByRole("heading", { level: 2 })).toHaveText(["Run", "Ticket"]);

  await page.goto(projectUrl);
  await expect(page.getByRole("heading", { name: "Cronker" })).toBeVisible();
  // On a Project's page, the sidebar leads to the Project's Terms.
  await page.getByRole("navigation", { name: "Sidebar" }).getByRole("link", { name: "Terms" }).click();
  await expect(page).toHaveURL(/\/projects\/[^/]+\/glossary$/);
  await expect(glossary.getByRole("heading", { level: 2 })).toHaveText(["Run", "Ticket"]);
  await expect(glossary.getByText("Avoid: Issue, task")).toBeVisible();
  await expect(glossary.getByText("Workspace", { exact: true })).toHaveCount(2);
  await page.getByLabel("Filter Terms").fill("task");
  await expect(glossary.getByRole("heading", { level: 2 })).toHaveText(["Ticket"]);
  await page.getByLabel("Filter Terms").fill("");
  await page.getByRole("button", { name: "New Term" }).click();
  await page.getByRole("dialog").getByLabel("Name").fill("run");
  await page.getByRole("textbox", { name: "Definition", exact: true }).fill("In this Project: one Claude session on a Ticket.");
  await page.getByLabel("Words to avoid").fill("session");
  await page.getByRole("button", { name: "Create Term" }).click();
  await expect(page.getByRole("heading", { name: "run", exact: true })).toBeVisible();
  await expect(page.getByText("CRONK Term")).toBeVisible();
  await expect(page.getByText("Version 1", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByRole("textbox", { name: "Definition", exact: true }).fill("In this Project: one Claude Code session on a Ticket.");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("article", { name: "run" })).toContainText("In this Project: one Claude Code session on a Ticket.");
  await expect(page.getByRole("region", { name: "Versions" }).getByRole("listitem")).toHaveCount(2);

  await page.goto(`${projectUrl}/glossary`);
  await expect(glossary.getByRole("heading", { level: 2 })).toHaveText(["run", "Ticket"]);
  await expect(glossary.getByText("In this Project: one Claude Code session on a Ticket.")).toBeVisible();
  await expect(glossary.getByText("One agent execution Cronk starts for one Ticket.")).toHaveCount(0);
  await expect(glossary.getByText("Workspace", { exact: true })).toHaveCount(1);
  await expect(glossary.getByText("Overrides the Workspace Term")).toHaveCount(1);

  await glossary.getByRole("link", { name: "run", exact: true }).click();
  await page.getByRole("button", { name: "More of this Term" }).click();
  await page.getByRole("menuitem", { name: "Delete Term" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(glossary.getByRole("heading", { level: 2 })).toHaveText(["Run", "Ticket"]);
});

/** Sets Cronk up, signs Ada in, and opens a Workspace Term Ada defined and Bea then saved again. */
async function openTerm(page: Page, cronk: StartedCronk) {
  const { workspace } = await setUp(cronk);
  const adaCookie = await signIn(cronk);
  const bea = await addMember(cronk, adaCookie, workspace.id, "bea@example.com");
  const created = await cronk.request("POST", `/api/workspaces/${workspace.id}/terms`, {
    cookie: adaCookie,
    body: { name: "Brief", definition: "The instructions a Run starts from.", avoid: ["Prompt"] },
  });
  const term = await created.json();
  await cronk.request("PATCH", `/api/terms/${term.id}`, {
    cookie: bea.cookie,
    body: { baseVersion: 1, definition: "The instructions a Run starts from: the preamble, the Step's text, the Ticket's key.", avoid: ["Prompt", "system prompt"] },
  });

  await page.goto(cronk.url);
  await page.getByLabel("Email").fill(firstUser.email);
  await page.getByLabel("Password").fill(firstUser.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Sidebar" })).toBeVisible();
  await page.goto(`${cronk.url}/terms/${term.id}`);
  await expect(page.getByRole("heading", { name: "Brief", level: 1 })).toBeVisible();
}

test("a Term reads as a Document does, and each of its Versions opens to what it said", async ({ page, cronk }) => {
  await openTerm(page, cronk);
  const term = page.getByRole("article", { name: "Brief" });
  await expect(term).toContainText("the preamble, the Step's text, the Ticket's key.");
  await expect(term).toContainText("Avoid: Prompt, system prompt");

  const versions = page.getByRole("region", { name: "Versions" });
  await expect(versions.getByRole("listitem")).toHaveText([/Version 2.*bea@example\.com/, /Version 1.*ada@example\.com/]);
  await versions.getByRole("button", { name: "Version 1" }).click();
  const version = page.getByRole("dialog", { name: "Version 1: Brief" });
  await expect(version).toContainText("ada@example.com");
  await expect(version.getByRole("article", { name: "Brief" })).toContainText("The instructions a Run starts from.");
  await expect(version.getByRole("article", { name: "Brief" })).toContainText("Avoid: Prompt");
});

test("a Term's Versions are listed with \"Pick two to see what changed\", and picking two shows their Diff naming both", async ({ page, cronk }) => {
  await openTerm(page, cronk);
  const versions = page.getByRole("region", { name: "Versions" });
  await expect(versions).toContainText("Pick two to see what changed.");

  await versions.getByLabel("Compare Version 1").check();
  await versions.getByLabel("Compare Version 2").check();
  const diff = page.getByRole("dialog", { name: "What changed" }).getByRole("region", { name: "Comparison" });
  await expect(diff).toContainText(/^Version 1\s*→\s*Version 2/);
  await expect(diff.getByRole("deletion")).toHaveText(["The instructions a Run starts from."]);
  await expect(diff.getByRole("insertion")).toHaveText([
    "The instructions a Run starts from: the preamble, the Step's text, the Ticket's key.",
    "system prompt",
  ]);
});

test("a renamed Term's Diff names both Versions by their names", async ({ page, cronk }) => {
  await openTerm(page, cronk);
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Run brief");
  await page.getByRole("button", { name: "Save as Version 3" }).click();
  await expect(page.getByRole("heading", { name: "Run brief", level: 1 })).toBeVisible();

  const versions = page.getByRole("region", { name: "Versions" });
  await versions.getByLabel("Compare Version 1").check();
  await versions.getByLabel("Compare Version 3").check();
  const diff = page.getByRole("dialog", { name: "What changed" }).getByRole("region", { name: "Comparison" });
  await expect(diff).toContainText(/^Version 1: Brief\s*→\s*Version 3: Run brief/);
});

test("a Term's definition is written in the shared editor, as formatted text, and saved as Markdown", async ({ page, cronk }) => {
  await openTerm(page, cronk);
  await page.getByRole("button", { name: "Edit" }).click();
  const definition = page.getByRole("textbox", { name: "Definition", exact: true });
  await definition.fill("The instructions a Run starts from, ");
  await definition.press("End");
  await definition.press("ControlOrMeta+b");
  await definition.pressSequentially("in full");
  await definition.press("ControlOrMeta+b");
  await definition.pressSequentially(".");
  await expect(definition.getByRole("strong")).toHaveText("in full");
  await page.getByLabel("Words to avoid").fill("Prompt, instructions");

  await page.getByRole("button", { name: "Save as Version 3" }).click();
  const term = page.getByRole("article", { name: "Brief" });
  await expect(term).toContainText("The instructions a Run starts from, in full.");
  await expect(term.getByRole("strong")).toHaveText("in full");
  await expect(term).toContainText("Avoid: Prompt, instructions");
  await expect(page.getByRole("region", { name: "Versions" }).getByRole("listitem")).toHaveCount(3);
});
