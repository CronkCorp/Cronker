import type { Page } from "@playwright/test";
import { setUp, signIn } from "../test/harness/flows.js";
import type { StartedCronk } from "../test/harness/start-cronk.js";
import { expect, signInInBrowser, test } from "./fixtures.js";

// The rich editor on Documents (docs/ui.md, Editor): formatting, the source toggle, keyboard use, phone width and the
// themes. Its round trip is tested without a browser (test/editor/); here the saved Markdown is read from the API.

/** Opens a Workspace Document with this body in the editor, and gives a way to read what it saves. */
async function editDocument(page: Page, cronk: StartedCronk, body: string) {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const created = await cronk.request("POST", `/api/workspaces/${workspace.id}/documents`, { cookie, body: { title: "Plan", body } });
  const document = await created.json();
  await signInInBrowser(page, cronk);
  await page.goto(`${cronk.url}/documents/${document.id}`);
  await page.getByRole("button", { name: "Edit" }).click();
  const saved = async () => (await (await cronk.request("GET", `/api/documents/${document.id}`, { cookie })).json()).body as string;
  return { text: page.getByRole("textbox", { name: "Body" }), saved };
}

const tool = (page: Page, name: string) => page.getByRole("toolbar", { name: "Formatting" }).getByRole("button", { name, exact: true });
const mode = (page: Page, name: "Rich text" | "Markdown") =>
  page.getByRole("group", { name: "Editing mode" }).getByRole("button", { name, exact: true });

test("the toolbar, keys and Markdown shortcuts format the text, and the Document saves plain Markdown", async ({ page, cronk }) => {
  const { text, saved } = await editDocument(page, cronk, "Runs start from a Brief.\n\n*   kept as written\n\nLast.\n");

  // A link pasted onto selected text links it.
  await text.getByText("Runs start from a Brief.").click();
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Shift+ControlOrMeta+ArrowLeft");
  await text.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", "https://example.com/brief");
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  });
  await expect(text.getByRole("link", { name: "Brief" })).toBeVisible();

  await text.getByText("Runs start from a").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("## Steps");
  await expect(text.getByRole("heading", { name: "Steps" })).toBeVisible();
  await expect(tool(page, "Heading 2")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Enter");
  await page.keyboard.type("First ");
  await page.keyboard.press("ControlOrMeta+b");
  await page.keyboard.type("bold");
  await page.keyboard.press("ControlOrMeta+b");
  await page.keyboard.type(" then ");
  await tool(page, "Italic").click();
  await expect(tool(page, "Italic")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.type("slanted");
  await tool(page, "Italic").click();
  await page.keyboard.type(" and `code`");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- [ ] tick me");
  await text.getByRole("checkbox", { name: "Done" }).click();
  await expect(text.getByRole("checkbox", { name: "Done" })).toBeChecked();

  await page.getByRole("button", { name: "Save as Version 2" }).click();
  await expect(page.getByRole("article", { name: "Plan" }).getByRole("heading", { name: "Steps" })).toBeVisible();
  // The list no edit touched keeps its own spacing.
  expect(await saved()).toBe(
    "Runs start from a [Brief](https://example.com/brief).\n\n*   kept as written\n\nLast.\n\n## Steps\n\nFirst **bold** then *slanted* and `code`\n\n- [x] tick me\n",
  );
});

test("the source toggle keeps edits made in either mode, and the last mode is remembered on this browser", async ({ page, cronk }) => {
  const { text, saved } = await editDocument(page, cronk, "Intro.\n\n<div>raw</div>\n");
  // Raw HTML can't be shown as formatted text, so it is edited as its source, in place.
  await expect(text.locator("pre[data-source]")).toHaveText("<div>raw</div>");

  await text.getByText("Intro.").click();
  await page.keyboard.press("Home");
  await page.keyboard.type("Rich ");
  await mode(page, "Markdown").click();
  const source = page.getByLabel("Body, as Markdown");
  await expect(source).toHaveValue("Rich Intro.\n\n<div>raw</div>\n");

  await source.fill("Rich Intro.\n\nFrom the source.\n\n<div>raw</div>\n");
  await mode(page, "Rich text").click();
  await expect(text.getByText("From the source.")).toBeVisible();
  await mode(page, "Markdown").click();
  await expect(source).toHaveValue("Rich Intro.\n\nFrom the source.\n\n<div>raw</div>\n");

  await page.getByRole("button", { name: "Save as Version 2" }).click();
  await expect(page.getByRole("article", { name: "Plan" })).toContainText("From the source.");
  expect(await saved()).toBe("Rich Intro.\n\nFrom the source.\n\n<div>raw</div>\n");
  await page.reload();
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(source).toHaveValue("Rich Intro.\n\nFrom the source.\n\n<div>raw</div>\n");
  await expect(mode(page, "Markdown")).toHaveAttribute("aria-pressed", "true");
});

test("by keyboard alone at phone width, in the dark theme, the toolbar is one stop with arrow keys between its buttons", async ({ page, cronk }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  const { text, saved } = await editDocument(page, cronk, "Words.");
  // Drawn on the dark theme's surface, and nothing wider than the phone.
  await expect(page.locator(".rich-editor-frame")).toHaveCSS("background-color", "rgb(26, 30, 27)");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect((await tool(page, "Bold").boundingBox())!.height).toBeGreaterThanOrEqual(40);

  await page.getByLabel("Title").focus();
  await page.keyboard.press("Tab");
  await expect(tool(page, "Heading 1")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(tool(page, "Heading 2")).toBeFocused();
  await page.keyboard.press("End");
  await expect(tool(page, "Redo")).toBeFocused();
  await page.keyboard.press("Home");
  await page.keyboard.press("Escape");
  await expect(text).toBeFocused();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" More");

  // Alt+F10 reaches the toolbar from the text; Enter applies the button, and the text has the focus again.
  await page.keyboard.press("Shift+Home");
  await page.keyboard.press("Alt+F10");
  await expect(tool(page, "Heading 1")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(text).toBeFocused();
  await expect(text.getByRole("heading", { level: 1 })).toHaveText("Words. More");

  // Tab from the text leaves the editor rather than staying in it.
  await page.keyboard.press("Tab");
  await expect(text).not.toBeFocused();
  await page.getByRole("button", { name: "Save as Version 2" }).click();
  await expect(page.getByRole("article", { name: "Plan" }).getByRole("heading", { level: 1 })).toBeVisible();
  expect(await saved()).toBe("# Words. More");
});

test("at a wide window the text fills the frame, so long lines wrap at its edge and newlines typed there are kept", async ({ page, cronk }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const { text, saved } = await editDocument(page, cronk, "Start.");
  const frame = page.locator(".rich-editor-frame");

  // The text box is as wide as the frame (less its border), not cut short at a measure of its own (CRONK-60).
  const widths = await text.evaluate((element) => {
    const frameBox = element.closest(".rich-editor-frame")!;
    return { text: element.getBoundingClientRect().width, frame: frameBox.clientWidth, scroll: element.scrollWidth, client: element.clientWidth };
  });
  expect(widths.frame).toBeGreaterThan(900);
  expect(widths.text).toBeGreaterThanOrEqual(widths.frame - 1);
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);

  // A long line of words and a long unbroken token both wrap inside the text, with nothing past its edge.
  const words = "Runs start from a Brief and finish with an Outcome ".repeat(6).trim();
  const token = "x".repeat(400);
  await text.getByText("Start.").click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type(words);
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("after the break");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText(token);
  const paragraphs = text.locator("p");
  const lineBoxes = await paragraphs.evaluateAll((elements) => {
    const box = elements[0]!.closest(".rich-editor-text")!.getBoundingClientRect();
    return elements.map((element) => ({ right: element.getBoundingClientRect().right, scroll: element.scrollWidth, client: element.clientWidth, limit: box.right }));
  });
  for (const line of lineBoxes) {
    expect(line.right).toBeLessThanOrEqual(line.limit);
    expect(line.scroll).toBeLessThanOrEqual(line.client);
  }
  // The long line of words reaches past 80% of the frame before it wraps.
  const reach = await paragraphs.nth(1).evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const rights = [...range.getClientRects()].map((rect) => rect.right);
    const box = element.closest(".rich-editor-frame")!.getBoundingClientRect();
    return (Math.max(...rights) - box.left) / box.width;
  });
  expect(reach).toBeGreaterThan(0.85);
  expect(await frame.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

  const body = `Start.\n\n${words}\\\nafter the break\n\n${token}`;
  await mode(page, "Markdown").click();
  await expect(page.getByLabel("Body, as Markdown")).toHaveValue(body);
  await mode(page, "Rich text").click();
  await page.getByRole("button", { name: "Save as Version 2" }).click();
  await expect(page.getByRole("article", { name: "Plan" })).toContainText("after the break");
  expect(await saved()).toBe(body);
  await page.reload();
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(text.locator("p")).toHaveCount(3);
  await expect(text.locator("p").nth(1).locator("br")).toHaveCount(1);
});
