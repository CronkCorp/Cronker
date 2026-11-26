import { setUp, signIn } from "../test/harness/flows.js";
import type { Page } from "@playwright/test";
import type { StartedCronk } from "../test/harness/start-cronk.js";
import { expect, fieldPicker, newTicket, openProjectSettings, pick, pickFilter, placeCommentButton, signInInBrowser, test } from "./fixtures.js";

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
  // The description is written in the shared editor, as formatted text.
  const description = page.getByRole("textbox", { name: "Description" });
  await description.fill("Comes after ");
  await description.press("End");
  await description.press("ControlOrMeta+b");
  await description.pressSequentially("CRONK-1");
  await description.press("ControlOrMeta+b");
  await description.pressSequentially(".");
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

  await page.getByRole("textbox", { name: "New Comment" }).fill("Blocked by CRONK-1?");
  await placeCommentButton(page).click();
  const comment = timeline.getByRole("article", { name: "Comment by ada@example.com" });
  await expect(comment).toHaveCount(1);
  await expect(comment).toContainText("Blocked by CRONK-1?");
  await comment.getByRole("button", { name: "Reply" }).click();
  await comment.getByRole("textbox", { name: "Reply" }).fill("Yes, it is.");
  await comment.getByRole("button", { name: "Send reply" }).click();
  const reply = comment.getByRole("article", { name: "Reply from ada@example.com" });
  await expect(reply).toContainText("Yes, it is.");
  await expect(reply).toContainText("in reply to ada@example.com");

  await page.getByRole("region", { name: "Description" }).getByRole("link", { name: "CRONK-1" }).click();
  await expect(page.getByRole("heading", { name: "CRONK-1 Drag me" })).toBeVisible();

  await page.getByRole("navigation", { name: "Sidebar" }).getByRole("link", { name: "Tickets" }).click();
  await pickFilter(page, "Priority", "High");
  await expect(board.getByRole("link", { name: /CRONK-/ })).toHaveText([/CRONK-2 Read me/]);
  await pickFilter(page, "Priority", "Any Priority");
  await pickFilter(page, "Label", "UI");
  await expect(board.getByRole("link", { name: /CRONK-/ })).toHaveText([/CRONK-2 Read me/]);
  await expect(page.getByRole("button", { name: "Filter by Label UI" })).toBeVisible();
  await pickFilter(page, "Label", "Any Label");
  // The Filter box narrows by a word of the title or by key, together with the other filters.
  const text = page.getByLabel("Filter Tickets", { exact: true });
  await text.fill("drag");
  await expect(board.getByRole("link", { name: /CRONK-/ })).toHaveText([/CRONK-1 Drag me/]);
  await text.fill("cronk-2");
  await expect(board.getByRole("link", { name: /CRONK-/ })).toHaveText([/CRONK-2 Read me/]);
  await pickFilter(page, "Status", "Triage");
  await expect(board.getByRole("link", { name: /CRONK-/ })).toHaveText([/CRONK-2 Read me/]);
  await text.fill("drag");
  await expect(board.getByRole("link", { name: /CRONK-/ })).toHaveCount(0);
  await pickFilter(page, "Status", "Any Status");
  await expect(board.getByRole("link", { name: /CRONK-/ })).toHaveText([/CRONK-1 Drag me/]);
  await text.press("Escape");
  await expect(text).toHaveValue("");
  await expect(board.getByRole("link", { name: /CRONK-/ })).toHaveCount(2);
  await pickFilter(page, "Assignee", "Nobody");
  await expect(board.getByRole("link", { name: /CRONK-/ })).toHaveText([/CRONK-1 Drag me/]);
  // The Label list holds the Project's Labels whatever is filtered, though CRONK-1 has none.
  await page.getByRole("button", { name: /^Filter by Label/ }).click();
  await expect(page.getByRole("listbox", { name: "Label" }).getByRole("option")).toHaveText([/Any Label/, "board", "UI"]);
  await page.keyboard.press("Escape");
  await pickFilter(page, "Assignee", "Anyone");
  await expect(page.getByRole("button", { name: "Filter by Status Any Status" })).toBeVisible();
  // From the keyboard: open, type to filter, Enter picks the first match.
  await page.getByRole("button", { name: /^Filter by Status/ }).focus();
  await page.keyboard.press("Enter");
  await page.keyboard.type("tria");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Filter by Status Triage" })).toBeVisible();
  await page.getByRole("navigation", { name: "Project views" }).getByRole("link", { name: "List" }).click();
  const list = page.getByRole("region", { name: "List" });
  await expect(list.getByRole("link", { name: /CRONK-/ })).toHaveText([/CRONK-2 Read me/]);

  await openProjectSettings(page);
  await page.getByRole("button", { name: "Remove Ready" }).click();
  await expect(page.getByRole("alert")).toContainText("Ready holds 1 Ticket");
  await expect(page.getByLabel("Name of Ready")).toBeVisible();
});

for (const { width, height } of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  test(`a long Status name stays inside the Ticket's Details column, with its model label, at ${width}px`, async ({ page, cronk }) => {
    await page.setViewportSize({ width, height });
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    const call = async (method: string, path: string, body?: unknown) => (await cronk.request(method, path, { cookie, body })).json();
    const project = await call("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
    // Triage has a Step, so its pill carries the Step's model label too.
    const triage = project.statuses.find((s: { name: string }) => s.name === "Triage");
    const long = "Averyveryveryveryveryveryverylongstatusnamewithnospacesatall";
    await call("PATCH", `/api/projects/${project.id}/statuses/${triage.id}`, { name: long });
    const ticket = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Long Status" });
    await call("PATCH", `/api/tickets/${ticket.id}`, { statusId: triage.id });

    await signInInBrowser(page, cronk);
    await page.getByRole("navigation", { name: "Sidebar" }).getByRole("link", { name: "Tickets" }).click();
    await page.getByRole("link", { name: /CRONK-1 Long Status/ }).click();
    await expect(page.getByRole("heading", { name: "CRONK-1 Long Status" })).toBeVisible();

    const status = fieldPicker(page, "Status");
    await expect(status).toHaveAttribute("title", long);
    await expect(status.locator(".model-label")).toHaveText("haiku");

    // Neither the Details column nor the page scrolls sideways: the name ends in an ellipsis instead.
    const details = page.getByRole("complementary", { name: "Details" });
    expect(await details.evaluate((e) => e.scrollWidth - e.clientWidth)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    expect(await status.locator(".status-pill-name").evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
    const fields = (await page.getByRole("region", { name: "Fields" }).boundingBox())!;
    const label = (await status.locator(".model-label").boundingBox())!;
    expect(label.x + label.width).toBeLessThanOrEqual(fields.x + fields.width);
  });
}

test("close a Ticket as a duplicate of another from its Relations", async ({ page, cronk }) => {
  await signedInWithProject(page, cronk);
  const board = page.getByRole("region", { name: "Board" });
  await newTicket(page, "Dark mode");
  await newTicket(page, "Night theme");
  await board.getByRole("link", { name: /CRONK-2 Night theme/ }).click();
  await expect(page.getByRole("heading", { name: "CRONK-2 Night theme" })).toBeVisible();

  const relations = page.getByRole("region", { name: "Relations" });
  await relations.getByRole("button", { name: /^Relation / }).click();
  await page.getByRole("option", { name: "Duplicate of (closes it)" }).click();
  await relations.getByRole("combobox", { name: "Ticket" }).fill("CRONK-1");
  await relations.getByRole("button", { name: "Add" }).click();

  await expect(relations.getByRole("list", { name: "Duplicate of" }).getByRole("link", { name: /CRONK-1 Dark mode/ })).toBeVisible();
  await expect(fieldPicker(page, "Status")).toContainText("Canceled");
  await page.getByRole("link", { name: /CRONK-1 Dark mode/ }).click();
  await expect(page.getByRole("heading", { name: "CRONK-1 Dark mode" })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Relations" }).getByRole("list", { name: "Duplicated by" }).getByRole("link", { name: /CRONK-2 Night theme/ }),
  ).toBeVisible();
});
