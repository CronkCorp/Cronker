import type { Page } from "@playwright/test";
import type { StartedCronk } from "../test/harness/start-cronk.js";
import { expect, fieldPicker, newTicket, openProjectSettings, pick, test } from "./fixtures.js";

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

  await newTicket(page, "Drag me");
  await expect(lane("Backlog").getByRole("link", { name: /CRONK-1 Drag me/ })).toBeVisible();
  await newTicket(page, "Read me");
  await expect(lane("Backlog").getByRole("link", { name: /CRONK-2 Read me/ })).toBeVisible();

  await lane("Backlog").getByRole("link", { name: /CRONK-1/ }).dragTo(lane("Ready"));
  await expect(lane("Ready").getByRole("link", { name: /CRONK-1 Drag me/ })).toBeVisible();
  await page.reload();
  await expect(lane("Ready").getByRole("link", { name: /CRONK-1 Drag me/ })).toBeVisible();
  await expect(lane("Backlog").getByRole("link", { name: /CRONK-1/ })).toHaveCount(0);

  await lane("Backlog").getByRole("link", { name: /CRONK-2/ }).click();
  await expect(page.getByRole("heading", { name: "CRONK-2 Read me" })).toBeVisible();
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Description").fill("Comes after **CRONK-1**.");
  await page.getByRole("button", { name: "Save" }).click();
  await pick(page, "Priority", "High");
  await expect(fieldPicker(page, "Priority")).toContainText("High");
  // Labels take new text: Enter adds what was typed, and the list stays open for the next.
  await fieldPicker(page, "Labels").click();
  await page.getByLabel("Filter Labels").fill("UI");
  await page.getByLabel("Filter Labels").press("Enter");
  await page.getByLabel("Filter Labels").fill("board");
  await page.getByLabel("Filter Labels").press("Enter");
  await page.keyboard.press("Escape");
  await expect(fieldPicker(page, "Labels")).toHaveAccessibleName("Labels UI board");
  await pick(page, "Assignee", "ada@example.com");
  await page.getByLabel("Due date").fill("2026-02-01");
  await page.getByLabel("Due date").press("Enter");
  await page.getByLabel("Estimate").fill("3");
  await page.getByLabel("Estimate").press("Enter");
  // Once something is typed, Enter picks the first match.
  await fieldPicker(page, "Status").click();
  await page.getByLabel("Filter Status").fill("tri");
  await page.getByLabel("Filter Status").press("Enter");
  await expect(fieldPicker(page, "Status")).toContainText("Triage");

  const timeline = page.getByRole("region", { name: "Timeline" });
  await expect(timeline).toContainText("ada@example.com created the Ticket");
  await expect(timeline).toContainText("ada@example.com changed Priority from None to High");
  await expect(timeline).toContainText("ada@example.com changed Status from Backlog to Triage");
  await expect(timeline).toContainText("ada@example.com changed Labels from none to UI");
  await expect(timeline).toContainText("ada@example.com changed Estimate from none to 3");

  await page.getByLabel("New Comment").fill("Blocked by CRONK-1?");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const comment = timeline.getByRole("article", { name: "Comment by ada@example.com" });
  await expect(comment).toHaveCount(1);
  await expect(comment).toContainText("Blocked by CRONK-1?");
  await comment.getByRole("button", { name: "Reply" }).click();
  await comment.getByLabel("Reply").fill("Yes, it is.");
  await comment.getByRole("button", { name: "Send reply" }).click();
  const reply = comment.getByRole("article", { name: "Reply from ada@example.com" });
  await expect(reply).toContainText("Yes, it is.");
  await expect(reply).toContainText("in reply to ada@example.com");

  await page.getByRole("region", { name: "Description" }).getByRole("link", { name: "CRONK-1" }).click();
  await expect(page.getByRole("heading", { name: "CRONK-1 Drag me" })).toBeVisible();

  await page.getByRole("link", { name: "CRONK Cronker" }).click();
  await page.getByLabel("Filter by Priority").selectOption("High");
  await expect(board.getByRole("link", { name: /CRONK-/ })).toHaveText([/CRONK-2 Read me/]);
  await page.getByLabel("Filter by Priority").selectOption("Any Priority");
  await page.getByLabel("Filter by Label").fill("ui");
  await expect(board.getByRole("link", { name: /CRONK-/ })).toHaveText([/CRONK-2 Read me/]);
  await page.getByLabel("Filter by Label").fill("");
  await page.getByLabel("Filter by Assignee").selectOption("Nobody");
  await expect(board.getByRole("link", { name: /CRONK-/ })).toHaveText([/CRONK-1 Drag me/]);
  await page.getByLabel("Filter by Assignee").selectOption("Anyone");
  await page.getByLabel("Filter by Status").selectOption("Triage");
  await page.getByRole("navigation", { name: "Project views" }).getByRole("link", { name: "List" }).click();
  const list = page.getByRole("region", { name: "List" });
  await expect(list.getByRole("link", { name: /CRONK-/ })).toHaveText([/CRONK-2 Read me/]);

  await openProjectSettings(page);
  await page.getByRole("button", { name: "Remove Ready" }).click();
  await expect(page.getByRole("alert")).toContainText("Ready holds 1 Ticket");
  await expect(page.getByLabel("Name of Ready")).toBeVisible();
});
