import type { Page } from "@playwright/test";
import { firstUser, setUp, signIn } from "../test/harness/flows.js";
import type { StartedCronk } from "../test/harness/start-cronk.js";
import { expect, test } from "./fixtures.js";

/** Sets Cronk up, signs Ada in, and opens a Workspace Document Ada wrote. */
async function openDocument(page: Page, cronk: StartedCronk, body: string) {
  const { workspace } = await setUp(cronk);
  const adaCookie = await signIn(cronk);
  const created = await cronk.request("POST", `/api/workspaces/${workspace.id}/documents`, {
    cookie: adaCookie,
    body: { title: "How Runs start", body },
  });
  const document = await created.json();

  await page.goto(cronk.url);
  await page.getByLabel("Email").fill(firstUser.email);
  await page.getByLabel("Password").fill(firstUser.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Sidebar" })).toBeVisible();
  await page.goto(`${cronk.url}/documents/${document.id}`);
  await expect(page.getByRole("heading", { name: "How Runs start" })).toBeVisible();
  return { document };
}

/** Pastes or drops files from the User's computer into the editor's text, as the browser hands them over. */
async function giveFiles(page: Page, kind: "paste" | "drop", names: string[]) {
  await page.getByRole("textbox", { name: "Body" }).evaluate(
    (text, { kind, names }) => {
      const transfer = new DataTransfer();
      for (const name of names) transfer.items.add(new File(["not really a picture"], name, { type: "image/png" }));
      // A drop lands where the pointer is: here, the text's top left corner.
      const { left, top } = text.getBoundingClientRect();
      const event =
        kind === "paste"
          ? new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true })
          : new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true, clientX: left + 30, clientY: top + 24 });
      text.dispatchEvent(event);
    },
    { kind, names },
  );
}

test("files pasted or dropped into the text become the Document's Attachments, each an attachment: picture shown in place", async ({ page, cronk }) => {
  const { document } = await openDocument(page, cronk, "Before.\n\nAfter.");
  await page.getByRole("button", { name: "Edit" }).click();
  const text = page.getByRole("textbox", { name: "Body" });
  const reference = (name: string) => `!\\[${name.replaceAll(".", "\\.")}\\]\\(attachment:[0-9a-f-]{36}\\)`;

  // The cursor sits at the end of "Before.".
  await text.getByText("Before.").click();
  await page.keyboard.press("End");
  await giveFiles(page, "paste", ["brief.png"]);
  await expect(text.getByRole("img", { name: "brief.png" })).toBeVisible();
  await giveFiles(page, "drop", ["one.png", "two.png"]);
  await expect(text.getByRole("img")).toHaveCount(3);

  await page.getByRole("button", { name: "Save as Version 2" }).click();
  const attachments = page.getByRole("region", { name: "Attachments" });
  for (const name of ["brief.png", "one.png", "two.png"]) await expect(attachments).toContainText(name);
  await expect(page.getByRole("article", { name: "How Runs start" }).getByRole("img")).toHaveCount(3);
  const saved = await (await cronk.request("GET", `/api/documents/${document.id}`, { cookie: await signIn(cronk) })).json();
  for (const name of ["brief.png", "one.png", "two.png"]) expect(saved.body).toMatch(new RegExp(reference(name)));
  // The pasted one went in at the cursor; the dropped ones where they were dropped.
  expect(saved.body).toMatch(new RegExp(`efore\\.${reference("brief.png")}\\n\\nAfter\\.$`));
});

test("Comments on a Document show under it, with replies, and arrive live", async ({ page, cronk }) => {
  const { document } = await openDocument(page, cronk, "Runs start on delegation.");
  const cookie = await signIn(cronk);
  const comments = page.getByRole("region", { name: "Comments" });
  await expect(comments.getByText("No Comments yet.")).toBeVisible();

  const box = comments.getByRole("textbox", { name: "New Comment" });
  await box.click();
  await page.keyboard.type("Does a Merge Step count?");
  await comments.getByRole("button", { name: /^Comment/ }).click();
  const mine = comments.getByRole("article", { name: "Comment by ada@example.com" });
  await expect(mine).toContainText("Does a Merge Step count?");

  await mine.getByRole("button", { name: "Reply" }).click();
  await page.keyboard.type("It does.");
  await mine.getByRole("button", { name: /^Send reply/ }).click();
  await expect(comments.getByRole("article", { name: "Reply from ada@example.com" })).toContainText("It does.");

  // Another's Comment arrives live.
  await cronk.request("POST", `/api/documents/${document.id}/comments`, { cookie, body: { body: "Added it to the page." } });
  await expect(comments.getByText("Added it to the page.")).toBeVisible();
});

test("a resolved thread hides with its replies, shows on request, unresolves, and resolves live", async ({ page, cronk }) => {
  const { document } = await openDocument(page, cronk, "Runs start on delegation.");
  const cookie = await signIn(cronk);
  const post = async (body: string, replyToId?: string) =>
    (await cronk.request("POST", `/api/documents/${document.id}/comments`, { cookie, body: { body, replyToId } })).json();
  const thread = await post("Does a Merge Step count?");
  await post("It does.", thread.id);
  const other = await post("Typo in the second line.");
  const comments = page.getByRole("region", { name: "Comments" });
  const first = comments.getByRole("article", { name: "Comment by ada@example.com" }).filter({ hasText: "Does a Merge Step count?" });
  await expect(first).toBeVisible();

  // The Resolve on the thread's first Comment, not on its reply.
  await first.getByRole("button", { name: "Resolve" }).first().click();
  await expect(comments.getByText("Does a Merge Step count?")).toBeHidden();
  await expect(comments.getByText("It does.")).toBeHidden();
  await expect(comments.getByText("Typo in the second line.")).toBeVisible();

  await comments.getByRole("button", { name: "Show resolved (1)" }).click();
  await expect(first).toContainText("Resolved by ada@example.com");
  await expect(comments.getByText("It does.")).toBeVisible();
  await first.getByRole("button", { name: "Unresolve" }).click();
  await expect(first).not.toContainText("Resolved by");
  await expect(comments.getByRole("button", { name: /resolved/ })).toBeHidden();

  // Another User's Resolve arrives live.
  await cronk.request("POST", `/api/comments/${other.id}/resolve`, { cookie });
  await expect(comments.getByText("Typo in the second line.")).toBeHidden();
  await expect(comments.getByRole("button", { name: "Show resolved (1)" })).toBeVisible();
});

test("selecting a passage comments on it, shown after its paragraph, and at the top once the passage is edited away", async ({ page, cronk }) => {
  const { document } = await openDocument(page, cronk, "Runs start on delegation.\n\nA Merge Step merges the Pull Request.");
  const cookie = await signIn(cronk);
  const body = page.getByRole("article", { name: "How Runs start" });

  // Selecting text within the first paragraph offers Comment under it.
  await body.getByText("Runs start on delegation.").evaluate((paragraph) => {
    const text = paragraph.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, "Runs start".length);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  });
  await page.getByRole("button", { name: "Comment on the selected passage" }).click();
  const dialog = page.getByRole("dialog", { name: "Comment on a passage" });
  await expect(dialog.getByLabel("Quoted passage")).toHaveText("Runs start");
  await page.keyboard.type("Only on delegation?");
  await dialog.getByRole("button", { name: /^Comment/ }).click();
  await expect(dialog).toBeHidden();

  // The thread sits after its paragraph, before the next one, not in the Comments panel.
  const thread = body.getByRole("list", { name: "Comments on this passage" });
  await expect(thread).toContainText("Only on delegation?");
  const [threadTop, nextTop] = await Promise.all([
    thread.evaluate((element) => element.getBoundingClientRect().top),
    body.getByText("A Merge Step merges").evaluate((element) => element.getBoundingClientRect().top),
  ]);
  expect(threadTop).toBeLessThan(nextTop);
  const comments = page.getByRole("region", { name: "Comments" });
  await expect(comments.getByText("No Comments yet.")).toHaveCount(0);
  await expect(comments.getByText("Only on delegation?")).toHaveCount(0);

  // Once an edit takes the passage away, the thread shows at the top of the Comments panel with its quote and Version.
  await cronk.request("PATCH", `/api/documents/${document.id}`, {
    cookie,
    body: { baseVersion: 1, body: "Delegation starts a Run.\n\nA Merge Step merges the Pull Request." },
  });
  await expect(thread).toBeHidden();
  const outdated = comments.getByLabel("Quoted passage");
  await expect(outdated).toContainText("Runs start");
  await expect(outdated).toContainText("Written on Version 1");
  await expect(comments.getByText("Only on delegation?")).toBeVisible();
});
