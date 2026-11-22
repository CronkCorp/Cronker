import type { Page } from "@playwright/test";
import { setUp, signIn } from "../test/harness/flows.js";
import type { StartedCronk } from "../test/harness/start-cronk.js";
import { expect, placeCommentButton, signInInBrowser, test } from "./fixtures.js";

/**
 * Ada signed in, with a Ticket she wrote (CRONK-1) and one whose Run asked her a Question (CRONK-2), which waits in
 * her Inbox.
 */
async function ticketsWithAQuestion(page: Page, cronk: StartedCronk) {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const call = async (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
    (await cronk.request(method, path, headers ? { headers, body } : { cookie, body })).json();
  const project = await call("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const triage = project.statuses.find((s: { name: string }) => s.name === "Triage").id;
  const runner = await call("POST", "/api/runners", { name: "Fake", kind: "fake" });
  const agent = await call("POST", `/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
  await call("PATCH", `/api/agents/${agent.id}`, { runnerId: runner.id });
  const { secret } = await call("POST", `/api/agents/${agent.id}/tokens`, { name: "cloud", access: "full" });
  await call("POST", `/api/projects/${project.id}/tickets`, { title: "Write it down" });
  const asked = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Pick a colour" });
  await call("PATCH", `/api/tickets/${asked.id}`, { delegateId: agent.id, statusId: triage });
  const running = (await call("GET", `/api/tickets/${asked.id}/runs`)).find((r: { state: string }) => r.state === "running");
  await call("POST", `/api/runs/${running.id}/finish`, { outcome: "needs you", question: "Blue or green?" }, { authorization: `Bearer ${secret}` });

  await signInInBrowser(page, cronk);
}

const openTicket = async (page: Page, key: string) => {
  await page.getByRole("navigation", { name: "Sidebar" }).getByRole("link", { name: /CRONK/ }).first().click();
  await page.getByRole("link", { name: new RegExp(key) }).first().click();
  await expect(page.getByRole("heading", { name: new RegExp(`^${key} `) })).toBeVisible();
};

test("Ctrl+Enter places a Comment from the Ticket's Comment box, while Enter and Shift+Enter add new lines", async ({ page, cronk }) => {
  await ticketsWithAQuestion(page, cronk);
  await openTicket(page, "CRONK-1");
  const timeline = page.getByRole("region", { name: "Timeline" });
  const box = page.getByRole("textbox", { name: "New Comment" });

  // An empty box places nothing.
  await box.press("Control+Enter");
  // The box is the shared editor: Enter starts a paragraph, Shift+Enter breaks the line, and formatting saves as Markdown.
  await box.pressSequentially("First line");
  await box.press("Enter");
  await box.pressSequentially("second ");
  await box.press("ControlOrMeta+b");
  await box.pressSequentially("bold");
  await box.press("ControlOrMeta+b");
  await box.press("Shift+Enter");
  await box.pressSequentially("third line");
  await expect(box.getByRole("strong")).toHaveText("bold");
  await expect(timeline.getByRole("article", { name: "Comment by ada@example.com" })).toHaveCount(0);

  await box.press("Control+Enter");
  const comment = timeline.getByRole("article", { name: "Comment by ada@example.com" });
  await expect(comment).toHaveCount(1);
  const paragraphs = comment.locator(".markdown p");
  await expect(paragraphs).toHaveCount(2);
  await expect(paragraphs.first()).toHaveText("First line");
  await expect(comment.getByRole("strong")).toHaveText("bold");
  await expect(paragraphs.last().locator("br")).toHaveCount(1);
  await expect(box).toHaveText("");
});

test("Ctrl+Enter places a Comment from the Markdown source too, as it was written", async ({ page, cronk }) => {
  await ticketsWithAQuestion(page, cronk);
  await openTicket(page, "CRONK-1");
  await page.getByRole("group", { name: "Editing mode" }).getByRole("button", { name: "Markdown", exact: true }).click();
  const source = page.getByRole("textbox", { name: "New Comment, as Markdown" });
  await source.fill("Written as **Markdown**.");
  await source.press("Control+Enter");
  const comment = page.getByRole("region", { name: "Timeline" }).getByRole("article", { name: "Comment by ada@example.com" });
  await expect(comment.getByRole("strong")).toHaveText("Markdown");
  await expect(source).toHaveValue("");
});

test("Cmd+Enter places a Reply to a Comment", async ({ page, cronk }) => {
  await ticketsWithAQuestion(page, cronk);
  await openTicket(page, "CRONK-1");
  await page.getByRole("textbox", { name: "New Comment" }).fill("Is it blocked?");
  await placeCommentButton(page).click();
  const comment = page.getByRole("region", { name: "Timeline" }).getByRole("article", { name: "Comment by ada@example.com" });
  await comment.getByRole("button", { name: "Reply" }).click();
  await comment.getByRole("textbox", { name: "Reply" }).fill("No, it isn't.");
  await comment.getByRole("textbox", { name: "Reply" }).press("Meta+Enter");
  await expect(comment.getByRole("article", { name: "Reply from ada@example.com" })).toContainText("No, it isn't.");
});

test("Ctrl+Enter answers a Question from the Inbox's answer box", async ({ page, cronk }) => {
  await ticketsWithAQuestion(page, cronk);
  await page.getByRole("navigation", { name: "Sidebar" }).getByRole("link", { name: /^Inbox/ }).click();
  const detail = page.getByRole("region", { name: "Selected item" });
  await expect(detail).toContainText("Blue or green?");
  const answer = detail.getByRole("textbox", { name: "Answer" });
  await answer.press("Control+Enter");
  await expect(detail).toContainText("Blue or green?");
  await answer.fill("Green.");
  await answer.press("Control+Enter");
  // The Question leaves the Inbox; the Ticket's needs you item stays, resolved elsewhere.
  await expect(page.getByRole("list", { name: "Inbox" }).getByRole("button", { name: /^Question / })).toHaveCount(0);
  await page.goto(page.url().replace(/\/workspaces\/.*$/, ""));
  await openTicket(page, "CRONK-2");
  await expect(page.getByRole("article", { name: "Question from claude-max" }).getByRole("article", { name: "Reply from ada@example.com" })).toContainText(
    "Green.",
  );
});

test("pressing Ctrl+Enter again while a Comment is being sent doesn't place it twice", async ({ page, cronk }) => {
  await ticketsWithAQuestion(page, cronk);
  await openTicket(page, "CRONK-1");
  // Hold the Comment's request until the keys have been pressed again, and held.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let sent = 0;
  await page.route(/\/api\/tickets\/[^/]+\/comments$/, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    sent++;
    await held;
    await route.continue();
  });
  const box = page.getByRole("textbox", { name: "New Comment" });
  await box.fill("Only once.");
  await box.press("Control+Enter");
  await expect.poll(() => sent).toBe(1);
  await box.press("Control+Enter");
  await page.keyboard.down("Control");
  await page.keyboard.down("Enter");
  await box.dispatchEvent("keydown", { key: "Enter", ctrlKey: true, repeat: true });
  await page.keyboard.up("Enter");
  await page.keyboard.up("Control");
  release();
  const comment = page.getByRole("region", { name: "Timeline" }).getByRole("article", { name: "Comment by ada@example.com" });
  await expect(comment).toHaveCount(1);
  await expect(box).toHaveText("");
  expect(sent).toBe(1);

  // A held key's repeats place nothing, even once the box is free again.
  await box.fill("Not from a held key.");
  await box.dispatchEvent("keydown", { key: "Enter", ctrlKey: true, repeat: true });
  await box.press("Shift+Enter");
  await expect(box.locator("br")).not.toHaveCount(0);
  await expect(box).toContainText("Not from a held key.");
  expect(sent).toBe(1);
});

test("the buttons that place a Comment show the shortcut as a hint, Ctrl+↵ off macOS", async ({ page, cronk }) => {
  await ticketsWithAQuestion(page, cronk);
  await openTicket(page, "CRONK-2");
  const comment = placeCommentButton(page);
  await expect(comment).toHaveText("Comment Ctrl+↵");
  await expect(comment).toHaveAttribute("aria-keyshortcuts", "Control+Enter");
  const question = page.getByRole("article", { name: "Question from claude-max" });
  await expect(question.getByRole("button", { name: "Post answer", exact: true })).toHaveText("Post answer Ctrl+↵");

  await page.getByRole("navigation", { name: "Sidebar" }).getByRole("link", { name: /^Inbox/ }).click();
  const answer = page.getByRole("region", { name: "Selected item" }).getByRole("button", { name: "Post answer", exact: true });
  await expect(answer).toHaveText("Post answer Ctrl+↵");
});

test("on macOS the hint is ⌘↵", async ({ page, cronk }) => {
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" }));
  await ticketsWithAQuestion(page, cronk);
  await openTicket(page, "CRONK-1");
  const comment = placeCommentButton(page);
  await expect(comment).toHaveText("Comment ⌘↵");
  await expect(comment).toHaveAttribute("aria-keyshortcuts", "Meta+Enter");
  await page.getByRole("textbox", { name: "New Comment" }).fill("Is it blocked?");
  await page.getByRole("textbox", { name: "New Comment" }).press("Meta+Enter");
  const placed = page.getByRole("region", { name: "Timeline" }).getByRole("article", { name: "Comment by ada@example.com" });
  await placed.getByRole("button", { name: "Reply" }).click();
  await expect(placed.getByRole("button", { name: "Send reply", exact: true })).toHaveText("Send reply ⌘↵");
});

test("a Comment Cronk refuses stays in its box with the refusal under it", async ({ page, cronk }) => {
  await ticketsWithAQuestion(page, cronk);
  await openTicket(page, "CRONK-1");
  // Only spaces, written as the Markdown source, pass the box's check, but Cronk refuses a Comment with no words.
  await page.getByRole("group", { name: "Editing mode" }).getByRole("button", { name: "Markdown", exact: true }).click();
  const box = page.getByRole("textbox", { name: "New Comment, as Markdown" });
  await box.fill("   ");
  await box.press("Control+Enter");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(box).toHaveValue("   ");
});
