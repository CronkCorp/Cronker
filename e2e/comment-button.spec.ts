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

/** The page head's Comment button, told from the Comment box's own by its shortcut. */
const commentButton = (page: Page) => page.getByRole("button", { name: "Comment", exact: true }).and(page.locator('[aria-keyshortcuts="C"]'));

test("the page head's Comment button takes the User from the top of a long Ticket to its Comment box", async ({ page, cronk }) => {
  const box = await longTicket(page, cronk);
  await commentButton(page).click();
  await expect(box).toBeFocused();
  await expect(box).toBeInViewport();

  // The box is where it was, at the end, and posting from it works as before.
  await box.fill("Picked up from the top.");
  await box.press("Control+Enter");
  const timeline = page.getByRole("region", { name: "Timeline" });
  await expect(timeline.getByRole("article", { name: "Comment by ada@example.com" }).last()).toContainText("Picked up from the top.");
});

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

test("C does nothing while a dialog is open", async ({ page, cronk }) => {
  const box = await longTicket(page, cronk);
  await page.getByRole("button", { name: "Link a Document…" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  // Out of the Picker's filter box, so only the open dialog keeps C from acting.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("c");
  await expect(box).not.toBeFocused();
});
