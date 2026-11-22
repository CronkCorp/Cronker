import { setUp, signIn } from "../test/harness/flows.js";
import { expect, signInInBrowser, test } from "./fixtures.js";

// Embeds in the rich editor (docs/ui.md, Rich editor): an Artifact's address alone in its paragraph shows as its
// Embed while editing, in the same sandboxed frame as reading, and is one block the User selects and removes whole.

const page = (text: string) => ({ path: "index.html", contentBase64: Buffer.from(`<h1>${text}</h1>`).toString("base64") });

test("an Embed shows while editing a Document, sandboxed, and is removed as one block", async ({ page: tab, cronk }) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const slug = (await (await cronk.request("GET", `/api/workspaces/${workspace.id}`, { cookie })).json()).slug;
  const created = await (
    await cronk.request("POST", `/api/workspaces/${workspace.id}/artifacts`, { cookie, body: { title: "Board", files: [page("Version one")] } })
  ).json();
  await cronk.request("PATCH", `/api/artifacts/${created.id}`, { cookie, body: { baseVersion: 1, files: [page("Version two")] } });
  const address = `${cronk.url}/${slug}/artifacts/${created.slug}?version=1`;
  const body = `The board as it was:\n\n${address}\n\nAnd in a sentence, <${address}> stays a link.\n`;
  const document = await (
    await cronk.request("POST", `/api/workspaces/${workspace.id}/documents`, { cookie, body: { title: "Roadmap", body } })
  ).json();
  const saved = async () => (await (await cronk.request("GET", `/api/documents/${document.id}`, { cookie })).json()).body as string;

  await signInInBrowser(tab, cronk);
  await tab.goto(`${cronk.url}/documents/${document.id}`);
  await tab.getByRole("button", { name: "Edit" }).click();
  const text = tab.getByRole("textbox", { name: "Body" });

  // The Embed shows in the text, in the reading view's sandbox, at the Version its address pins.
  const embed = text.getByRole("figure", { name: "Embedded Artifact Board" });
  await expect(embed).toHaveCount(1);
  const frame = embed.locator("iframe");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect(embed.frameLocator("iframe").getByRole("heading")).toHaveText("Version one");
  await expect(text.locator(".rich-editor-embed")).toHaveAttribute("contenteditable", "false");
  // The address in a sentence stays a link.
  await expect(text.getByRole("link", { name: address })).toBeVisible();

  // Clicking its caption selects it whole; Backspace removes it, and only it.
  await embed.locator(".embed-title").click();
  await expect(text.locator(".rich-editor-embed.ProseMirror-selectednode")).toHaveCount(1);
  await tab.keyboard.press("Backspace");
  await expect(embed).toHaveCount(0);
  await tab.keyboard.press("ControlOrMeta+z");
  await expect(embed).toHaveCount(1);

  // The source mode shows its address to edit; back in the text, it's the Embed again.
  await tab.getByRole("group", { name: "Editing mode" }).getByRole("button", { name: "Markdown", exact: true }).click();
  await expect(tab.getByRole("textbox", { name: "Body, as Markdown" })).toHaveValue(body);
  await tab.getByRole("group", { name: "Editing mode" }).getByRole("button", { name: "Rich text", exact: true }).click();
  await expect(text.getByRole("figure", { name: "Embedded Artifact Board" })).toHaveCount(1);

  // Removed and saved, the rest of the text is as written.
  await text.getByRole("figure", { name: "Embedded Artifact Board" }).locator(".embed-title").click();
  await tab.keyboard.press("Delete");
  await expect(text.getByRole("figure")).toHaveCount(0);
  await tab.getByRole("button", { name: /^Save as Version/ }).click();
  await expect.poll(saved).toBe(`The board as it was:\n\nAnd in a sentence, <${address}> stays a link.\n`);
});
