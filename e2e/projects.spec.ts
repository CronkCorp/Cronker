import { expect, openProjectSettings, test } from "./fixtures.js";
import type { StartedCronk } from "../test/harness/start-cronk.js";
import type { Page } from "@playwright/test";

async function signedIn(page: Page, cronk: StartedCronk) {
  const setup = await cronk.request("POST", "/api/setup", {
    body: {
      setupCode: cronk.setupCode(),
      email: "ada@example.com",
      password: "correct horse battery",
      workspaceName: "Ada's Workspace",
    },
  });
  expect(setup.status).toBe(201);
  await page.goto(cronk.url);
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Ada's Workspace" })).toBeVisible();
}

const defaultBoard = [
  "Backlog",
  "Triage",
  "Ready",
  "Investigate",
  "Implement",
  "Code review",
  "Merge",
  "In Review",
  "Done",
  "Canceled",
];

test("create a Project, see its empty board and list, and edit its Statuses in settings", async ({ page, cronk }) => {
  await signedIn(page, cronk);

  await page.getByLabel("Project name").fill("Cronker");
  await page.getByLabel("Key").fill("CRONK");
  await page.getByRole("button", { name: "Create Project" }).click();

  await expect(page.getByRole("heading", { name: "Cronker" })).toBeVisible();
  const statusHeadings = page.getByRole("region", { name: "Board" }).getByRole("heading", { level: 2 });
  await expect(statusHeadings).toHaveText(defaultBoard);

  await page.getByRole("navigation", { name: "Project views" }).getByRole("link", { name: "List" }).click();
  await expect(page.getByRole("region", { name: "List" }).getByRole("heading", { level: 2 })).toHaveText(defaultBoard);
  await expect(page.getByText("No Tickets yet.")).toBeVisible();

  await openProjectSettings(page);
  await expect(page.getByRole("heading", { name: "Statuses" })).toBeVisible();

  await page.getByRole("button", { name: "Remove Canceled" }).click();
  await expect(page.getByRole("alert")).toContainText("needs at least one Canceled Status");

  await page.getByLabel("New Status name").fill("Blocked");
  await page.getByLabel("New Status kind").selectOption("Active");
  await page.getByRole("button", { name: "Add Status" }).click();
  await expect(page.getByLabel("Name of Blocked")).toBeVisible();

  await page.getByLabel("Name of Ready").fill("Todo");
  await page.getByRole("button", { name: "Rename Ready" }).click();
  await expect(page.getByLabel("Name of Todo")).toBeVisible();

  await page.getByLabel("Kind of Code review").selectOption("Review");
  await expect(page.getByLabel("Kind of Code review")).toHaveValue("review");

  await page.getByRole("button", { name: "Move Blocked up" }).click();
  await page.getByRole("button", { name: "Remove Investigate" }).click();
  await expect(page.getByLabel("Name of Investigate")).toHaveCount(0);

  await page.getByRole("link", { name: "CRONK Cronker" }).click();
  await expect(statusHeadings).toHaveText([
    "Backlog",
    "Triage",
    "Todo",
    "Implement",
    "Code review",
    "Merge",
    "In Review",
    "Done",
    "Blocked",
    "Canceled",
  ]);

  await page.reload();
  await expect(statusHeadings).toHaveText([
    "Backlog",
    "Triage",
    "Todo",
    "Implement",
    "Code review",
    "Merge",
    "In Review",
    "Done",
    "Blocked",
    "Canceled",
  ]);

  await page.getByRole("button", { name: "Workspace: Ada's Workspace" }).click();
  await page.getByRole("menuitem", { name: "Ada's Workspace" }).click();
  await expect(page.getByRole("heading", { name: "Ada's Workspace" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Cronker CRONK" })).toBeVisible();
});
