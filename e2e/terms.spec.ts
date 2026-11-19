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

  await page.getByRole("navigation").getByRole("link", { name: "Glossary" }).first().click();
  await expect(page.getByRole("heading", { name: "Ada's Workspace Glossary" })).toBeVisible();
  for (const [name, definition, avoid] of [
    ["Ticket", "A unit of work tracked within a Project.", "Issue, task"],
    ["Run", "One agent execution Cronk starts for one Ticket.", "job"],
  ]) {
    await page.getByLabel("New Term name").fill(name!);
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
  await page.getByRole("link", { name: "Glossary", exact: true }).last().click();
  await expect(page).toHaveURL(/\/projects\/[^/]+\/glossary$/);
  await expect(glossary.getByRole("heading", { level: 2 })).toHaveText(["Run", "Ticket"]);
  await expect(glossary.getByText("Avoid: Issue, task")).toBeVisible();
  await expect(glossary.getByText("Workspace Term")).toHaveCount(2);
  await page.getByLabel("New Term name").fill("run");
  await page.getByRole("textbox", { name: "Definition", exact: true }).fill("In this Project: one Claude session on a Ticket.");
  await page.getByLabel("Words to avoid").fill("session");
  await page.getByRole("button", { name: "Create Term" }).click();
  await expect(page.getByRole("heading", { name: "run", exact: true })).toBeVisible();
  await expect(page.getByText("Version 1 by ada@example.com").first()).toBeVisible();

  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByRole("textbox", { name: "Definition", exact: true }).fill("In this Project: one Claude Code session on a Ticket.");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("In this Project: one Claude Code session on a Ticket.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Versions" }).getByRole("listitem")).toHaveCount(2);

  await page.goto(`${projectUrl}/glossary`);
  await expect(glossary.getByRole("heading", { level: 2 })).toHaveText(["run", "Ticket"]);
  await expect(glossary.getByText("In this Project: one Claude Code session on a Ticket.")).toBeVisible();
  await expect(glossary.getByText("One agent execution Cronk starts for one Ticket.")).toHaveCount(0);
  await expect(glossary.getByText("Workspace Term")).toHaveCount(1);

  await glossary.getByRole("link", { name: "run", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete Term" }).click();
  await expect(glossary.getByRole("heading", { level: 2 })).toHaveText(["Run", "Ticket"]);
});
