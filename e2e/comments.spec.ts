import type { Page } from "@playwright/test";
import { setUp, signIn } from "../test/harness/flows.js";
import type { StartedCronk } from "../test/harness/start-cronk.js";
import { expect, signInInBrowser, test } from "./fixtures.js";

/** Ada signed in, on a Ticket whose timeline runs far past the window: 25 Comments, oldest first. */
async function longTicket(page: Page, cronk: StartedCronk) {
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
  const box = page.getByLabel("New Comment");
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
  await expect(box).toHaveValue("");

  // Holding C types no c's once it has focused the box.
  await box.blur();
  await page.keyboard.down("c");
  await page.keyboard.down("c");
  await page.keyboard.down("c");
  await page.keyboard.up("c");
  await expect(box).toBeFocused();
  await expect(box).toHaveValue("");

  // Typing in the box types; the c is the User's.
  await page.keyboard.type("cc");
  await expect(box).toHaveValue("cc");

  // Typing c in another field doesn't leave it for the Comment box.
  await page.evaluate(() => window.scrollTo(0, 0));
  const reply = page.getByRole("region", { name: "Timeline" }).getByRole("article", { name: "Comment by ada@example.com" }).first();
  await reply.getByRole("button", { name: "Reply" }).click();
  const replyBox = reply.getByLabel("Reply");
  await replyBox.focus();
  await page.keyboard.type("c");
  await expect(replyBox).toBeFocused();
  await expect(replyBox).toHaveValue("c");
  await expect(box).toHaveValue("cc");
});

test("Ctrl+Enter places a Comment from the Ticket's Comment box, while Enter and Shift+Enter add new lines", async ({ page, cronk }) => {
  const box = await longTicket(page, cronk);
  const timeline = page.getByRole("region", { name: "Timeline" });

  // An empty box places nothing.
  await box.press("Control+Enter");
  await box.pressSequentially("First line");
  await box.press("Enter");
  await box.pressSequentially("second line");
  await box.press("Shift+Enter");
  await box.pressSequentially("third line");
  await expect(box).toHaveValue("First line\nsecond line\nthird line");
  const comments = timeline.getByRole("article", { name: "Comment by ada@example.com" });
  await expect(comments).toHaveCount(25);

  await box.press("Control+Enter");
  await expect(comments).toHaveCount(26);
  await expect(comments.last()).toContainText("third line");
  await expect(box).toHaveValue("");
});
