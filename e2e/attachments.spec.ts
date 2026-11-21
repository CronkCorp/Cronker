import type { Locator, Page } from "@playwright/test";
import { setUp, signIn } from "../test/harness/flows.js";
import type { StartedCronk } from "../test/harness/start-cronk.js";
import { expect, placeCommentButton, signInInBrowser, test } from "./fixtures.js";

/** Sets Cronk up with a Project and one Ticket, and opens the Ticket in the browser as Ada. */
async function openTicket(page: Page, cronk: StartedCronk) {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const call = async (path: string, body: unknown) => (await cronk.request("POST", path, { cookie, body })).json();
  const project = await call(`/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const ticket = await call(`/api/projects/${project.id}/tickets`, { title: "Rate-limit sign-in", description: "Too many attempts." });
  await signInInBrowser(page, cronk);
  await page.goto(`${cronk.url}/tickets/${ticket.id}`);
  await expect(page.getByRole("heading", { name: /Rate-limit sign-in/ })).toBeVisible();
  return { cookie, ticket };
}

/** Pastes or drops files from the User's computer onto something on the page, as the browser hands them over, with text alongside when given. */
async function giveFiles(target: Locator, kind: "paste" | "drop", files: { name: string; type: string }[], text?: string) {
  await target.evaluate(
    (element, { kind, files, text }) => {
      const transfer = new DataTransfer();
      for (const file of files) transfer.items.add(new File(["x".repeat(2048)], file.name, { type: file.type }));
      if (text) transfer.setData("text/plain", text);
      const event =
        kind === "paste"
          ? new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true })
          : new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true });
      element.dispatchEvent(event);
    },
    { kind, files, text },
  );
}

test("files dropped or pasted anywhere on a Ticket attach to it, as thumbnails naming their size and who attached them", async ({ page, cronk }) => {
  await openTicket(page, cronk);
  const attachments = page.getByRole("region", { name: "Attachments", exact: true });
  await expect(attachments.getByRole("heading", { name: "Attachments" })).toBeVisible();
  await expect(attachments.getByText("Drop files or paste to attach")).toBeVisible();

  // Dropped on the timeline, far from the drop zone, it is the Ticket's all the same.
  await giveFiles(page.getByRole("region", { name: "Timeline" }), "drop", [{ name: "proxy-ip.png", type: "image/png" }]);
  await expect(attachments.getByRole("heading", { name: "Attachments · 1" })).toBeVisible();

  // Pasted into the Comment box without text, a file attaches to the Ticket too.
  const commentBox = page.getByRole("textbox", { name: "New Comment" });
  await giveFiles(commentBox, "paste", [{ name: "sign-in-flood.log", type: "text/plain" }]);
  await expect(attachments.getByRole("listitem")).toHaveCount(2);
  const image = attachments.getByRole("button", { name: "Open proxy-ip.png" });
  // A picture shows itself rather than its type.
  await expect(image).toHaveText("proxy-ip.png2.0 KB · ada@example.com");
  // Anything but a picture shows as its type.
  await expect(attachments.getByRole("button", { name: "Open sign-in-flood.log" })).toHaveText("LOGsign-in-flood.log2.0 KB · ada@example.com");

  // A paste into a text field that carries text too pastes the text and attaches nothing.
  await giveFiles(commentBox, "paste", [{ name: "copied.png", type: "image/png" }], "copied words");
  await placeCommentButton(page).focus();
  await page.reload();
  await expect(attachments.getByRole("heading", { name: "Attachments · 2" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Files" })).not.toContainText("copied.png");
});

test("an Attachment opens from its thumbnail or the Files group in a wide dialog with Download, and Remove asks first", async ({ page, cronk }) => {
  const { cookie, ticket } = await openTicket(page, cronk);
  const comment = await (await cronk.request("POST", `/api/tickets/${ticket.id}/comments`, { cookie, body: { body: "The trace." } })).json();
  const attach = (path: string, name: string, type: string) =>
    fetch(new URL(`${path}?name=${encodeURIComponent(name)}`, cronk.url), { method: "POST", headers: { cookie, "content-type": type }, body: "x" });
  await attach(`/api/tickets/${ticket.id}/attachments`, "proxy-ip.png", "image/png");
  await attach(`/api/comments/${comment.id}/attachments`, "trace.json", "application/json");
  await page.reload();
  const files = page.getByRole("region", { name: "Files" });
  await expect(files.getByRole("listitem")).toHaveCount(2);

  // A picture shows in full, with Download.
  await page.getByRole("region", { name: "Attachments", exact: true }).getByRole("button", { name: "Open proxy-ip.png" }).click();
  let dialog = page.getByRole("dialog", { name: "proxy-ip.png" });
  await expect(dialog.getByRole("img", { name: "proxy-ip.png" })).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Download" })).toHaveAttribute("download", "proxy-ip.png");
  await dialog.getByRole("button", { name: "Close" }).click();

  // A Comment's file opens from the Files group as its type, and may be removed there too, after asking.
  await files.getByRole("button", { name: "trace.json" }).click();
  dialog = page.getByRole("dialog", { name: "trace.json" });
  await expect(dialog).toContainText("JSON");
  await expect(dialog.getByRole("link", { name: "Download" })).toHaveAttribute("download", "trace.json");
  await dialog.getByRole("button", { name: "Remove…" }).click();
  const confirm = page.getByRole("dialog", { name: "Remove trace.json?" });
  await confirm.getByRole("button", { name: "Cancel" }).click();
  // Changing its mind leaves the file open, not removed.
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Remove…" }).click();
  await confirm.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(files.getByRole("listitem")).toHaveText([/proxy-ip\.png/]);
});
