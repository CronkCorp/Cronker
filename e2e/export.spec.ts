import { readFile } from "node:fs/promises";
import { unzip } from "../test/harness/zip.js";
import { expect, test } from "./fixtures.js";

test("download a Project's Terms and Decisions as a zip from its Glossary and Decisions tabs", async ({ page, cronk }) => {
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

  await page.goto(`${projectUrl}/glossary`);
  await page.getByLabel("New Term name").fill("Ticket");
  await page.getByRole("textbox", { name: "Definition", exact: true }).fill("A unit of work.");
  await page.getByRole("button", { name: "Create Term" }).click();
  await expect(page.getByRole("heading", { name: "Ticket", exact: true })).toBeVisible();
  await page.goto(`${projectUrl}/decisions`);
  await page.getByLabel("New Decision title").fill("Use Postgres");
  await page.getByRole("button", { name: "Record Decision" }).click();
  await expect(page.getByRole("heading", { name: "Use Postgres" })).toBeVisible();

  const expected = new Map([
    ["GLOSSARY.md", "# Glossary\n\n**Ticket**:\nA unit of work.\n"],
    ["docs/adr/0001-use-postgres.md", "# Use Postgres\n\nStatus: proposed\n"],
  ]);
  for (const tab of ["glossary", "decisions"]) {
    await page.goto(`${projectUrl}/${tab}`);
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Export" }).click()]);
    expect(download.suggestedFilename()).toBe("CRONK-knowledge.zip");
    expect(unzip(await readFile((await download.path())!))).toEqual(expected);
  }
});
