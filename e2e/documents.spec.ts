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
