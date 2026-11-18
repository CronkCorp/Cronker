import type { Page } from "@playwright/test";
import type { StartedCronk } from "../test/harness/start-cronk.js";
import { expect, test } from "./fixtures.js";

async function signedInWithProject(page: Page, cronk: StartedCronk) {
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
  await page.getByLabel("Project name").fill("Cronker");
  await page.getByLabel("Key").fill("CRONK");
  await page.getByRole("button", { name: "Create Project" }).click();
  await expect(page.getByRole("heading", { name: "Cronker" })).toBeVisible();
}

test("create Tickets, drag one across the board, edit it, comment, follow a key link and filter", async ({
  page,
  cronk,
}) => {
  await signedInWithProject(page, cronk);
  const board = page.getByRole("region", { name: "Board" });
  const lane = (name: string) => board.getByRole("region", { name, exact: true });

  await page.getByLabel("New Ticket title").fill("Drag me");
  await page.getByRole("button", { name: "Create Ticket" }).click();
  await expect(lane("Backlog").getByRole("link", { name: /CRONK-1 Drag me/ })).toBeVisible();
  await page.getByLabel("New Ticket title").fill("Read me");
  await page.getByRole("button", { name: "Create Ticket" }).click();
  await expect(lane("Backlog").getByRole("link", { name: /CRONK-2 Read me/ })).toBeVisible();

  await lane("Backlog").getByRole("link", { name: /CRONK-1/ }).dragTo(lane("Ready"));
  await expect(lane("Ready").getByRole("link", { name: /CRONK-1 Drag me/ })).toBeVisible();
  await page.reload();
  await expect(lane("Ready").getByRole("link", { name: /CRONK-1 Drag me/ })).toBeVisible();
  await expect(lane("Backlog").getByRole("link", { name: /CRONK-1/ })).toHaveCount(0);

  await lane("Backlog").getByRole("link", { name: /CRONK-2/ }).click();
  await expect(page.getByRole("heading", { name: "CRONK-2 Read me" })).toBeVisible();
  await page.getByLabel("Edit description").fill("Comes after **CRONK-1**.");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByLabel("Priority").selectOption("High");
  await page.getByLabel("Labels").fill("UI, board");
  await page.getByLabel("Labels").press("Enter");
  await page.getByLabel("Assignee").selectOption("ada@example.com");
  await page.getByLabel("Due date").fill("2026-02-01");
  await page.getByLabel("Due date").press("Enter");
  await page.getByLabel("Estimate").fill("3");
  await page.getByLabel("Estimate").press("Enter");
  await page.getByLabel("Status").selectOption("Triage");

  const timeline = page.getByRole("region", { name: "Timeline" });
  await expect(timeline).toContainText("ada@example.com created the Ticket");
  await expect(timeline).toContainText("ada@example.com changed Priority from None to High");
  await expect(timeline).toContainText("ada@example.com changed Status from Backlog to Triage");
  await expect(timeline).toContainText("ada@example.com changed Estimate from none to 3");

  await page.getByLabel("New Comment").fill("Blocked by CRONK-1?");
  await page.getByRole("button", { name: "Comment" }).click();
  const comments = page.getByRole("region", { name: "Comments" });
  await expect(comments.getByRole("article")).toHaveCount(1);
  await comments.getByRole("button", { name: "Reply" }).click();
  await page.getByLabel("Reply").fill("Yes, it is.");
  await page.getByRole("button", { name: "Send reply" }).click();
  await expect(comments.getByRole("article").nth(1)).toContainText("Yes, it is.");
  await expect(comments.getByRole("article").nth(1)).toContainText("in reply to ada@example.com");

  await page.getByRole("region", { name: "Description" }).getByRole("link", { name: "CRONK-1" }).click();
  await expect(page.getByRole("heading", { name: "CRONK-1 Drag me" })).toBeVisible();

  await page.getByRole("link", { name: "Cronker" }).click();
  await page.getByLabel("Filter by Priority").selectOption("High");
  await expect(board.getByRole("link", { name: /CRONK-/ })).toHaveText([/CRONK-2 Read me/]);
  await page.getByLabel("Filter by Priority").selectOption("Any");
  await page.getByLabel("Filter by Label").fill("ui");
  await expect(board.getByRole("link", { name: /CRONK-/ })).toHaveText([/CRONK-2 Read me/]);
  await page.getByLabel("Filter by Label").fill("");
  await page.getByLabel("Filter by Assignee").selectOption("Nobody");
  await expect(board.getByRole("link", { name: /CRONK-/ })).toHaveText([/CRONK-1 Drag me/]);
  await page.getByLabel("Filter by Assignee").selectOption("Anyone");
  await page.getByLabel("Filter by Status").selectOption("Triage");
  await page.getByRole("link", { name: "List" }).click();
  const list = page.getByRole("region", { name: "List" });
  await expect(list.getByRole("link", { name: /CRONK-/ })).toHaveText([/CRONK-2 Read me/]);

  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Remove Ready" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Ready holds 1 Ticket. Move it to another Status before removing it.",
  );
  await expect(page.getByLabel("Name of Ready")).toBeVisible();
});
