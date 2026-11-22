// Embeds in the rich editor (CRONK-24): an Artifact's address alone in its
// paragraph loads as one `embed` block, which round-trips byte for byte,
// moves and deletes whole, and is read by the same rules as the Mention
// index's. See docs/testing.md, seam 8.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Node } from "prosemirror-model";
import { EditorState, NodeSelection, TextSelection } from "prosemirror-state";
import { describe, expect, test } from "vitest";
import { addressAlone as serverAddressAlone, embedAddress as serverEmbedAddress } from "../../server/work/mentions.js";
import { fromMarkdown } from "mdast-util-from-markdown";
import { addressAlone, embedAddress } from "../../web/src/editor/embed-address.js";
import { openMarkdown } from "../../web/src/editor/round-trip.js";
import { markdownOf, openDraft, sliceFromText } from "../../web/src/editor/state.js";

const sample = readFileSync(join(import.meta.dirname, "samples", "embeds.md"), "utf8");
const address = "https://cronk.example.com/acme/artifacts/board-prototype-3f9a1b2c";

function types(doc: Node): string[] {
  const all: string[] = [];
  doc.forEach((node) => all.push(node.type.name));
  return all;
}

/** The position before the document's `index`th top-level node. */
function before(doc: Node, index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  return pos;
}

describe("the editor reads addresses as the Mention index does", () => {
  const written = [
    address,
    `${address}?version=2`,
    "/acme/artifacts/board-3f9a1b2c",
    "/artifacts/3f9a1b2c-0000-4000-8000-000000000000",
    "/artifacts/not-an-id",
    `${address}?version=0`,
    `${address}?version=2&x=1`,
    `${address}#top`,
    "https://user:pw@cronk.example.com/acme/artifacts/a",
    "https://cronk.example.com/acme/documents/a",
    "https://cronk.example.com/acme/artifacts/a/b",
    "/acme/artifacts/%E0%A4%A",
    "mailto:someone@example.com",
    "just words",
  ];
  test.each(written)("%s", (text) => {
    expect(embedAddress(text)).toEqual(serverEmbedAddress(text));
  });

  const paragraphs = [address, `<${address}>`, `  ${address}  `, `See ${address}`, `[Board](${address})`, `**${address}**`, `[${address}](${address})`];
  test.each(paragraphs)("paragraph %s", (markdown) => {
    const paragraph = fromMarkdown(markdown).children[0]!;
    if (paragraph.type !== "paragraph") throw new Error("not a paragraph");
    expect(addressAlone(paragraph)).toBe(serverAddressAlone(paragraph));
  });
});

describe("loading", () => {
  test("an address alone in its paragraph is an Embed; beside other words it stays a paragraph", () => {
    const opened = openMarkdown(sample);
    expect(types(opened.doc)).toEqual(["paragraph", "embed", "paragraph"]);
    expect(opened.doc.child(1).attrs).toMatchObject({ address, markdown: address, block: 1 });
  });

  test("an autolink alone is an Embed kept as written", () => {
    const markdown = `Before\n\n<${address}?version=2>\n\nAfter\n`;
    const opened = openMarkdown(markdown);
    expect(types(opened.doc)).toEqual(["paragraph", "embed", "paragraph"]);
    expect(opened.doc.child(1).attrs).toMatchObject({ address: `${address}?version=2`, markdown: `<${address}?version=2>` });
    expect(opened.save(opened.doc)).toBe(markdown);
  });

  test("an address in a list, a quote or a link with words is no Embed", () => {
    for (const markdown of [`- ${address}`, `> ${address}`, `[Board](${address})`, `\`${address}\``, `${address}#top`]) {
      expect(types(openMarkdown(markdown).doc)).not.toContain("embed");
    }
  });
});

describe("round trip", () => {
  test("the sample comes back byte for byte, with Windows line endings too", () => {
    for (const markdown of [sample, sample.replace(/\n/g, "\r\n")]) {
      const opened = openMarkdown(markdown);
      expect(opened.save(opened.doc)).toBe(markdown);
    }
  });

  test("an edit beside an Embed leaves it as written", () => {
    const markdown = `Intro\n\n\n${address}\n\nOutro\n`;
    const opened = openMarkdown(markdown);
    const state = EditorState.create({ doc: opened.doc });
    const tr = state.tr.insertText("Edited ", 1);
    const doc = tr.insertText(" too", tr.doc.content.size - 1).doc;
    expect(opened.save(doc)).toBe(`Edited Intro\n\n\n${address}\n\nOutro too\n`);
  });

  test("an Embed written anew saves as its Markdown", () => {
    const opened = openMarkdown("Intro\n");
    const embed = openMarkdown(`<${address}>`).doc.firstChild!;
    const doc = EditorState.create({ doc: opened.doc }).tr.insert(opened.doc.content.size, embed.type.create({ ...embed.attrs, block: null })).doc;
    expect(opened.save(doc)).toBe(`Intro\n\n<${address}>\n`);
  });
});

describe("one block", () => {
  const markdown = `One\n\n${address}\n\nTwo\n\nThree\n`;

  test("selected and deleted, it goes whole, and only it", () => {
    const draft = openDraft(markdown);
    const at = before(draft.state.doc, 1);
    const selected = draft.state.apply(draft.state.tr.setSelection(NodeSelection.create(draft.state.doc, at)));
    expect((selected.selection as NodeSelection).node.type.name).toBe("embed");
    const deleted = selected.apply(selected.tr.deleteSelection());
    expect(markdownOf(draft, deleted)).toBe("One\n\nTwo\n\nThree\n");
  });

  test("moved, it keeps its address as written", () => {
    const draft = openDraft(markdown);
    const doc = draft.state.doc;
    const embed = doc.child(1);
    const at = before(doc, 1);
    const tr = draft.state.tr.delete(at, at + embed.nodeSize);
    tr.insert(tr.doc.content.size, embed);
    expect(markdownOf(draft, draft.state.apply(tr))).toBe(`One\n\nTwo\n\nThree\n\n${address}\n`);
  });

  test("typing doesn't go into it", () => {
    const draft = openDraft(markdown);
    const at = before(draft.state.doc, 1);
    const selected = draft.state.apply(draft.state.tr.setSelection(NodeSelection.create(draft.state.doc, at)));
    // Typing over a selected Embed replaces it, as with any selected block; the address never takes the text.
    const typed = selected.apply(selected.tr.insertText("x"));
    expect(markdownOf(draft, typed)).not.toContain("board-prototype-3f9a1b2cx");
    expect(draft.state.doc.child(1).isAtom).toBe(true);
    expect(draft.state.doc.child(1).isLeaf).toBe(true);
  });
});

describe("pasting", () => {
  test("an address pasted on a line of its own is an Embed", () => {
    const state = openDraft("").state;
    const slice = sliceFromText(address, state.selection.$from);
    expect(slice.content.firstChild!.type.name).toBe("embed");
  });

  test("an address pasted into a sentence stays text", () => {
    const state0 = openDraft("Some words").state;
    const state = state0.apply(state0.tr.setSelection(TextSelection.create(state0.doc, 3)));
    const slice = sliceFromText(address, state.selection.$from);
    expect(slice.content.firstChild!.type.name).toBe("paragraph");
  });
});
