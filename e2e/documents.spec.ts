import type { Page } from "@playwright/test";
import { addMember, firstUser, setUp, signIn } from "../test/harness/flows.js";
import type { StartedCronk } from "../test/harness/start-cronk.js";
import { expect, test } from "./fixtures.js";

/** Sets Cronk up with Ada and Bea in one Workspace, signs Ada in, and opens a Workspace Document Ada wrote. */
async function openDocument(page: Page, cronk: StartedCronk, body: string) {
  const { workspace } = await setUp(cronk);
  const adaCookie = await signIn(cronk);
  const bea = await addMember(cronk, adaCookie, workspace.id, "bea@example.com");
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
  /** Bea saves the Document on top of the Version she names. */
  const beaSaves = (baseVersion: number, body: string) =>
    cronk.request("PATCH", `/api/documents/${document.id}`, { cookie: bea.cookie, body: { baseVersion, body } });
  return { document, beaSaves };
}

test("a refused save keeps the draft under a banner naming who saved which Version, with a Diff of their changes", async ({ page, cronk }) => {
  const { beaSaves } = await openDocument(page, cronk, "Runs start from a Brief.");
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByRole("button", { name: "Save as Version 2" })).toBeVisible();
  await page.getByLabel("Markdown").fill("Runs start from a Brief.\nAda's line.");

  // Meanwhile Bea saves Version 2, so Ada's save on Version 1 is refused.
  expect((await beaSaves(1, "Runs start from a Brief.\nBea's line.")).status).toBe(200);
  await page.getByRole("button", { name: "Save as Version 2" }).click();

  const banner = page.getByRole("note", { name: "Saved meanwhile" });
  await expect(banner).toContainText("bea@example.com saved Version 2");
  const theirChanges = banner.getByRole("region", { name: "Their changes" });
  await expect(theirChanges.getByRole("deletion")).toHaveText("Ada's line.");
  await expect(theirChanges.getByRole("insertion")).toHaveText("Bea's line.");
  await expect(page.getByLabel("Markdown")).toHaveValue("Runs start from a Brief.\nAda's line.");
  // Version 2 is Bea's now, so no button offers to save as Version 2 again.
  await expect(page.getByRole("button", { name: "Save as Version 2" })).toHaveCount(0);

  // Ada folds Bea's line in, bases her draft on Version 2, and saves Version 3.
  await page.getByLabel("Markdown").fill("Runs start from a Brief.\nBea's line.\nAda's line.");
  await banner.getByRole("button", { name: "Base my draft on Version 2" }).click();
  await expect(banner).toHaveCount(0);
  await page.getByRole("button", { name: "Save as Version 3" }).click();
  await expect(page.getByRole("article", { name: "How Runs start" })).toContainText("Bea's line. Ada's line.");
  await expect(page.getByRole("region", { name: "Versions" }).getByRole("listitem")).toHaveCount(3);
});

/** Pastes or drops files from the User's computer into the Markdown source, as the browser hands them over, at the cursor. */
async function giveFiles(page: Page, kind: "paste" | "drop", names: string[]) {
  await page.getByLabel("Markdown").evaluate(
    (source, { kind, names }) => {
      const transfer = new DataTransfer();
      for (const name of names) transfer.items.add(new File(["not really a picture"], name, { type: "image/png" }));
      const event =
        kind === "paste"
          ? new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true })
          : new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true });
      source.dispatchEvent(event);
    },
    { kind, names },
  );
}

test("files pasted or dropped into the Markdown become the Document's Attachments, each an attachment: picture at the cursor", async ({ page, cronk }) => {
  await openDocument(page, cronk, "Before.\nAfter.");
  await page.getByRole("button", { name: "Edit" }).click();
  const source = page.getByLabel("Markdown");
  const reference = (name: string) => new RegExp(`!\\[${name.replaceAll(".", "\\.")}\\]\\(attachment:[0-9a-f-]{36}\\)`);

  // The cursor sits after "Before.\n".
  await source.evaluate((textarea: HTMLTextAreaElement) => textarea.setSelectionRange(8, 8));
  await giveFiles(page, "paste", ["brief.png"]);
  await expect(source).toHaveValue(new RegExp(`^Before\\.\\n${reference("brief.png").source}After\\.$`));

  await source.evaluate((textarea: HTMLTextAreaElement) => textarea.setSelectionRange(0, 0));
  await giveFiles(page, "drop", ["one.png", "two.png"]);
  await expect(source).toHaveValue(new RegExp(`^${reference("one.png").source}\\n${reference("two.png").source}Before\\.`));

  // The preview shows them as the read view will, and the Document lists them as its Attachments.
  await expect(page.getByRole("region", { name: "Preview" }).getByRole("img")).toHaveCount(3);
  await page.getByRole("button", { name: "Save as Version 2" }).click();
  const attachments = page.getByRole("region", { name: "Attachments" });
  for (const name of ["brief.png", "one.png", "two.png"]) await expect(attachments).toContainText(name);
});

test("a Document reads with its Versions beside it, and picking two shows their Diff naming both", async ({ page, cronk }) => {
  const { beaSaves } = await openDocument(page, cronk, "Runs start from a Brief.\nOne Brief per Run.");
  await beaSaves(1, "Runs start from a Brief.\nEach Run has its own Brief.");
  await page.reload();

  await expect(page.getByRole("article", { name: "How Runs start" })).toContainText("Each Run has its own Brief.");
  const versions = page.getByRole("region", { name: "Versions" });
  await expect(versions.getByRole("listitem")).toHaveText([/Version 2.*bea@example\.com/, /Version 1.*ada@example\.com/]);

  await versions.getByLabel("Compare Version 1").check();
  await versions.getByLabel("Compare Version 2").check();
  const diff = page.getByRole("dialog", { name: "What changed" }).getByRole("region", { name: "Comparison" });
  await expect(diff).toContainText(/^Version 1\s*→\s*Version 2/);
  await expect(diff.getByRole("deletion")).toHaveText("One Brief per Run.");
  await expect(diff.getByRole("insertion")).toHaveText("Each Run has its own Brief.");
});

test("a Ticket links a Document of its Project or the Workspace from a picker, and unlinks it", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const post = async (path: string, body: unknown) => (await cronk.request("POST", path, { cookie, body })).json();
  const project = await post(`/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const ticket = await post(`/api/projects/${project.id}/tickets`, { title: "Rate-limit sign-in" });
  await post(`/api/projects/${project.id}/documents`, { title: "Security notes" });
  await post(`/api/workspaces/${workspace.id}/documents`, { title: "How Runs start" });

  await page.goto(cronk.url);
  await page.getByLabel("Email").fill(firstUser.email);
  await page.getByLabel("Password").fill(firstUser.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Sidebar" })).toBeVisible();
  await page.goto(`${cronk.url}/tickets/${ticket.id}`);

  const linked = page.getByRole("region", { name: "Linked Documents" });
  await linked.getByRole("button", { name: "Link a Document" }).click();
  const offered = page.getByRole("listbox", { name: "Link a Document" });
  await expect(offered.getByRole("group", { name: "This Project" }).getByRole("option")).toHaveText(["Security notes"]);
  await expect(offered.getByRole("group", { name: "The Workspace" }).getByRole("option")).toHaveText(["How Runs start"]);
  // Typing filters; Enter links the first match.
  await page.getByRole("combobox", { name: "Filter Link a Document" }).fill("runs");
  await page.getByRole("combobox", { name: "Filter Link a Document" }).press("Enter");
  await expect(linked.getByRole("list", { name: "Linked Documents" }).getByRole("link")).toHaveText(["How Runs start"]);
  await expect(page.getByRole("region", { name: "Timeline" })).toContainText("linked the Document How Runs start");

  // A linked Document is no longer offered.
  await linked.getByRole("button", { name: "Link a Document" }).click();
  await expect(offered.getByRole("option")).toHaveText(["Security notes"]);
  await page.keyboard.press("Escape");

  await linked.getByRole("button", { name: "Unlink" }).click();
  await expect(linked.getByRole("list", { name: "Linked Documents" })).toHaveCount(0);
});
