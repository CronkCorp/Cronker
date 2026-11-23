import type { Page, Route } from "@playwright/test";
import { setUp, signIn } from "../test/harness/flows.js";
import type { StartedCronk } from "../test/harness/start-cronk.js";
import { expect, signInInBrowser, test } from "./fixtures.js";

/**
 * Ada signed in, on a Ticket whose timeline runs far past the window: 25 Comments, oldest first. With `editorLoading`,
 * the shared editor is held back, so its box isn't waited for.
 */
async function longTicket(page: Page, cronk: StartedCronk, { editorLoading = false } = {}) {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const call = async (method: string, path: string, body?: unknown) => (await cronk.request(method, path, { cookie, body })).json();
  const project = await call("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const ticket = await call("POST", `/api/projects/${project.id}/tickets`, { title: "A long-running Ticket" });
  for (let i = 1; i <= 25; i++) await call("POST", `/api/tickets/${ticket.id}/comments`, { body: `Comment number ${i}` });
  await page.setViewportSize({ width: 1280, height: 800 });
  await signInInBrowser(page, cronk);
  await page.goto(`${cronk.url}/tickets/${ticket.id}`);
  await expect(page.getByRole("heading", { name: /^CRONK-1 / })).toBeVisible();
  await expect(page.getByText("Comment number 25")).toBeAttached();
  const box = page.getByRole("textbox", { name: "New Comment" });
  if (editorLoading) return box;
  // The box is the shared editor, loaded once the Ticket shows; it waits at the end, out of view.
  await expect(box).toBeAttached();
  await expect(box).not.toBeInViewport();
  return box;
}

test("C takes the User to the Comment box without typing a c, and does nothing while typing or with a modifier held", async ({ page, cronk }) => {
  const box = await longTicket(page, cronk);
  await expect(page.getByText("C writes a Comment")).toBeVisible();

  // With a modifier held, C does nothing.
  for (const chord of ["Control+c", "Meta+c", "Alt+c"]) {
    await page.keyboard.press(chord);
    await expect(box).not.toBeFocused();
  }
  await expect(box).not.toBeInViewport();

  await page.keyboard.press("c");
  await expect(box).toBeFocused();
  await expect(box).toBeInViewport();
  await expect(box).toHaveText("");

  // Holding C types no c's once it has focused the box.
  await box.blur();
  await page.keyboard.down("c");
  await page.keyboard.down("c");
  await page.keyboard.down("c");
  await page.keyboard.up("c");
  await expect(box).toBeFocused();
  await expect(box).toHaveText("");

  // Typing in the box types; the c is the User's.
  await page.keyboard.type("cc");
  await expect(box).toHaveText("cc");

  // Typing c in another field doesn't leave it for the Comment box.
  await page.evaluate(() => window.scrollTo(0, 0));
  const reply = page.getByRole("region", { name: "Timeline" }).getByRole("article", { name: "Comment by ada@example.com" }).first();
  await reply.getByRole("button", { name: "Reply" }).click();
  const replyBox = reply.getByRole("textbox", { name: "Reply" });
  await replyBox.focus();
  await page.keyboard.type("c");
  await expect(replyBox).toBeFocused();
  await expect(replyBox).toHaveText("c");
  await expect(box).toHaveText("cc");
});

test("C pressed while the editor still loads takes the User to the Comment box once it is in", async ({ page, cronk }) => {
  // The rich editor is loaded the first time a screen shows one: hold it back until C has been pressed.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/assets/rich-editor-*.js", async (route: Route) => {
    await held;
    await route.continue();
  });
  const box = await longTicket(page, cronk, { editorLoading: true });
  await expect(page.getByText("Loading the editor…")).toBeAttached();
  await expect(page.getByText("C writes a Comment")).toBeVisible();

  await page.keyboard.press("c");
  release();
  await expect(box).toBeFocused();
  await expect(box).toBeInViewport();
  // The C took the User there and typed nothing; what they type next lands in the box.
  await expect(box).toHaveText("");
  await page.keyboard.type("x");
  await expect(box).toHaveText("x");
});

test("Ctrl+Enter places a Comment from the rich editor and from its Markdown source, while Enter and Shift+Enter add new lines", async ({ page, cronk }) => {
  const box = await longTicket(page, cronk);
  const comments = page.getByRole("region", { name: "Timeline" }).getByRole("article", { name: "Comment by ada@example.com" });

  // An empty box places nothing.
  await box.press("Control+Enter");
  // Enter starts a paragraph and Shift+Enter breaks the line; both are saved as Markdown.
  await box.pressSequentially("First line");
  await box.press("Enter");
  await box.pressSequentially("second line");
  await box.press("Shift+Enter");
  await box.pressSequentially("third line");
  await expect(comments).toHaveCount(25);

  await box.press("Control+Enter");
  await expect(comments).toHaveCount(26);
  const paragraphs = comments.last().locator(".markdown p");
  await expect(paragraphs).toHaveCount(2);
  await expect(paragraphs.first()).toHaveText("First line");
  await expect(paragraphs.last().locator("br")).toHaveCount(1);
  await expect(box).toHaveText("");

  // From the Markdown source, the Comment is placed as it was written.
  await page.getByRole("group", { name: "Editing mode" }).getByRole("button", { name: "Markdown", exact: true }).click();
  const source = page.getByRole("textbox", { name: "New Comment, as Markdown" });
  await source.fill("Written as **Markdown**.");
  await source.press("Control+Enter");
  await expect(comments).toHaveCount(27);
  await expect(comments.last().getByRole("strong")).toHaveText("Markdown");
  await expect(source).toHaveValue("");
});

test("a Comment on a Report shows on its Ticket's timeline, marked with the Report, live", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const call = async (method: string, path: string, body?: unknown, as: { cookie?: string; headers?: Record<string, string> } = { cookie }) =>
    (await cronk.request(method, path, { ...as, body })).json();
  const project = await call("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const ticket = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Sign in with GitHub" });
  const runner = await call("POST", "/api/runners", { name: "Fake", kind: "fake" });
  const agent = await call("POST", `/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
  await call("PATCH", `/api/agents/${agent.id}`, { runnerId: runner.id });
  const { secret } = await call("POST", `/api/agents/${agent.id}/tokens`, { name: "cloud", access: "full" });
  const triage = project.statuses.find((s: { name: string }) => s.name === "Triage").id;
  await call("PATCH", `/api/tickets/${ticket.id}`, { delegateId: agent.id, statusId: triage });
  const report = await call(
    "POST",
    `/api/tickets/${ticket.id}/reports`,
    { title: "Findings", body: "Use the OAuth app." },
    { headers: { authorization: `Bearer ${secret}` } },
  );
  await call("POST", `/api/documents/${report.id}/comments`, { body: "Which OAuth app?" });
  await signInInBrowser(page, cronk);

  await page.goto(`${cronk.url}/tickets/${ticket.id}`);
  const timeline = page.getByRole("region", { name: "Timeline" });
  const onReport = timeline.getByRole("article", { name: "Comment by ada@example.com" }).first();
  await expect(onReport).toContainText("Which OAuth app?");
  await expect(onReport.getByRole("link", { name: "Findings" })).toBeVisible();
  // Another arrives live.
  await call("POST", `/api/documents/${report.id}/comments`, { body: "Cronk's own." });
  await expect(timeline.getByText("Cronk's own.")).toBeVisible();
});
