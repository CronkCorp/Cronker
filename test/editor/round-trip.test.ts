// The rich editor's round trip (CRONK-20): Markdown loaded into the editor's
// document and saved again. Untouched Markdown comes back byte for byte, an
// edit changes only the block it touched, Markdown the editor can't show is
// kept as an editable source block, and the source mode goes through the
// same round trip. See docs/testing.md, seam 8.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Node } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { describe, expect, test } from "vitest";
import { openMarkdown } from "../../web/src/editor/round-trip.js";

const root = join(import.meta.dirname, "../..");
const samplesDir = join(import.meta.dirname, "samples");

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? markdownFiles(join(dir, entry.name))
      : entry.name.endsWith(".md")
        ? [join(dir, entry.name)]
        : [],
  );
}

// The handwritten samples, each aimed at something Markdown editors lose,
// and this repository's own docs as real-world Markdown.
const samples = [
  ...markdownFiles(samplesDir),
  join(root, "README.md"),
  join(root, "CONTEXT.md"),
  join(root, "AGENTS.md"),
  ...markdownFiles(join(root, "docs")),
].map((path) => ({ name: path.slice(root.length + 1), markdown: readFileSync(path, "utf8") }));

function sample(name: string): string {
  return readFileSync(join(samplesDir, name), "utf8");
}

// The position just inside the first textblock of the document's `index`th
// top-level node, or null when it has none (a horizontal rule).
function insideBlock(doc: Node, index: number): number | null {
  let start = 0;
  for (let i = 0; i < index; i++) start += doc.child(i).nodeSize;
  const block = doc.child(index);
  if (block.isTextblock) return start + 1;
  let found: number | null = null;
  block.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.isTextblock) found = start + 1 + pos + 1;
    return found === null;
  });
  return found;
}

function edit(doc: Node, change: (state: EditorState) => EditorState["tr"]): Node {
  return change(EditorState.create({ doc })).doc;
}

function blockTypes(doc: Node): string[] {
  const types: string[] = [];
  doc.forEach((node) => types.push(node.type.name));
  return types;
}

describe.each(samples)("$name", ({ markdown }) => {
  test("comes back byte for byte without edits", () => {
    const opened = openMarkdown(markdown);
    expect(opened.save(opened.doc)).toBe(markdown);
  });

  test("an edit to one block changes only that block", () => {
    const opened = openMarkdown(markdown);
    opened.blocks.forEach(({ from, to }, index) => {
      const pos = insideBlock(opened.doc, index);
      if (pos === null) return;
      const saved = opened.save(edit(opened.doc, (state) => state.tr.insertText("Edited ", pos)));
      expect(saved.slice(0, from)).toBe(markdown.slice(0, from));
      expect(saved.slice(saved.length - (markdown.length - to))).toBe(markdown.slice(to));
      const block = saved.slice(from, saved.length - (markdown.length - to));
      expect(block).toContain("Edited");
      // A formatted block reads back as one block again, its edit included.
      // (A source block is written as typed, which may make it more blocks.)
      if (opened.doc.child(index).type.name === "source_block") return;
      const reopened = openMarkdown(saved);
      expect(reopened.doc.childCount).toBe(opened.doc.childCount);
      expect(reopened.doc.child(index).textContent).toContain("Edited");
    });
  });

  test("the source mode round-trips", () => {
    // Switching to the source shows the saved Markdown; switching back loads
    // it again, and saving that without edits gives it back unchanged.
    const opened = openMarkdown(markdown);
    const source = opened.save(opened.doc);
    const back = openMarkdown(source);
    expect(back.save(back.doc)).toBe(markdown);
  });
});

describe("unknown syntax", () => {
  test("raw HTML, footnotes and link definitions are source blocks, kept as written", () => {
    const markdown = sample("html-and-footnotes.md");
    const opened = openMarkdown(markdown);
    const sources: string[] = [];
    opened.doc.forEach((node, _offset, index) => {
      if (node.type.name !== "source_block") return;
      const { from, to } = opened.blocks[index]!;
      expect(node.textContent).toBe(markdown.slice(from, to));
      sources.push(node.textContent);
    });
    expect(sources).toEqual([
      "Here is a claim with a footnote.[^1] And a <kbd>Ctrl</kbd>+<kbd>K</kbd> shortcut.",
      "<details>\n<summary>More</summary>",
      "</details>",
      "<!-- a comment kept as written -->",
      "[^1]: The footnote's text,\n    with a lazy second line.",
      '[ref]: https://example.com "Reference"',
    ]);
  });

  test("a source block is edited as its Markdown, written back as typed", () => {
    const markdown = sample("html-and-footnotes.md");
    const opened = openMarkdown(markdown);
    const index = blockTypes(opened.doc).indexOf("source_block");
    const { from } = opened.blocks[index]!;
    const saved = opened.save(
      edit(opened.doc, (state) => state.tr.insertText("<b>Note:</b> ", insideBlock(opened.doc, index)!)),
    );
    expect(saved).toBe(markdown.slice(0, from) + "<b>Note:</b> " + markdown.slice(from));
  });

  test("Markdown the editor shows is formatted, not source", () => {
    expect(blockTypes(openMarkdown(sample("tables-and-tasks.md")).doc)).toEqual([
      "heading",
      "bullet_list",
      "bullet_list",
      "bullet_list",
      "table",
      "ordered_list",
    ]);
    expect(blockTypes(openMarkdown(sample("code.md")).doc)).toEqual([
      "paragraph",
      "code_block",
      "paragraph",
      "code_block",
      "code_block",
      "code_block",
      "paragraph",
    ]);
    expect(blockTypes(openMarkdown(sample("nested-lists.md")).doc)).toEqual([
      "bullet_list",
      "bullet_list",
      "ordered_list",
      "bullet_list",
    ]);
  });
});

describe("edited blocks", () => {
  test("are written in one style", () => {
    const markdown = "Mixed _underscore_ and __strong__\nover two lines  \nwith a break.\n\nSetext\n======\n";
    const opened = openMarkdown(markdown);
    let doc = edit(opened.doc, (state) => state.tr.insertText("Now ", 1));
    doc = edit(doc, (state) => state.tr.insertText("New ", insideBlock(doc, 1)!));
    expect(opened.save(doc)).toBe(
      "Now Mixed *underscore* and **strong**\nover two lines\\\nwith a break.\n\n# New Setext\n",
    );
  });

  test("keep the file's Windows line endings", () => {
    const markdown = sample("crlf.md");
    const opened = openMarkdown(markdown);
    const saved = opened.save(edit(opened.doc, (state) => state.tr.insertText("zero, ", insideBlock(opened.doc, 1)!)));
    expect(saved).toBe("Windows line endings\r\n\r\n- zero, one\r\n- two\r\n\r\nLast line\r\n");
  });

  test("ticking a task item changes only its marker", () => {
    const markdown = "Before\n\n- [ ] Write the suite\n- [x] Pick the candidates\n\nAfter\n";
    const opened = openMarkdown(markdown);
    const list = opened.doc.child(1);
    const saved = opened.save(
      edit(opened.doc, (state) =>
        state.tr.setNodeMarkup(opened.doc.child(0).nodeSize + 1, undefined, {
          ...list.firstChild!.attrs,
          checked: true,
        }),
      ),
    );
    expect(saved).toBe("Before\n\n- [x] Write the suite\n- [x] Pick the candidates\n\nAfter\n");
  });

  test("keep attachment references, Mentions and Embed addresses", () => {
    for (const name of ["attachments.md", "mentions.md", "embeds.md"]) {
      const markdown = sample(name);
      const opened = openMarkdown(markdown);
      // Touch every block, so all of them go through the serialiser.
      let doc = opened.doc;
      for (let i = 0; i < doc.childCount; i++) {
        const pos = insideBlock(doc, i);
        // An Embed has no text to touch; its own suite moves and removes it.
        if (pos === null) continue;
        doc = edit(doc, (state) => state.tr.insertText("x", pos).delete(pos, pos + 1));
      }
      const saved = opened.save(doc);
      for (const kept of markdown.match(/attachment:[0-9a-f-]+|[A-Z]+-\d+|[A-Z]+\/\d+|https:\/\/\S+[a-z0-9]/g)!) {
        expect(saved).toContain(kept);
      }
    }
  });
});

describe("blocks added, removed and moved", () => {
  const markdown = "One\n\n\n\nTwo\n\nThree\n";

  test("a removed block takes one separator with it", () => {
    const opened = openMarkdown(markdown);
    const two = opened.doc.child(0).nodeSize;
    const saved = opened.save(edit(opened.doc, (state) => state.tr.delete(two, two + opened.doc.child(1).nodeSize)));
    expect(saved).toBe("One\n\nThree\n");
  });

  test("a new block gets one blank line and leaves its neighbours alone", () => {
    const opened = openMarkdown(markdown);
    const end = opened.doc.content.size;
    const saved = opened.save(
      edit(opened.doc, (state) =>
        state.tr.insert(end, state.schema.nodes.paragraph!.create(null, state.schema.text("Four"))),
      ),
    );
    expect(saved).toBe("One\n\n\n\nTwo\n\nThree\n\nFour\n");
  });

  test("an empty new paragraph adds nothing", () => {
    const opened = openMarkdown(markdown);
    const saved = opened.save(
      edit(opened.doc, (state) => state.tr.insert(opened.doc.child(0).nodeSize, state.schema.nodes.paragraph!.create())),
    );
    expect(saved).toBe("One\n\n\n\nTwo\n\nThree\n");
  });

  test("empty and blank Markdown come back as they were", () => {
    for (const blank of ["", "\n", "  \n\n"]) {
      const opened = openMarkdown(blank);
      expect(opened.save(opened.doc)).toBe(blank);
    }
  });
});

describe("the source mode", () => {
  test("shows an edit made in the editor, and keeps it on the way back", () => {
    const markdown = sample("tables-and-tasks.md");
    const opened = openMarkdown(markdown);
    const source = opened.save(edit(opened.doc, (state) => state.tr.insertText("Edited ", insideBlock(opened.doc, 0)!)));
    expect(source.startsWith("## Edited Checklist\n")).toBe(true);
    const back = openMarkdown(source);
    expect(back.save(back.doc)).toBe(source);
  });

  test("an edit made in the source is kept byte for byte", () => {
    const edited = sample("odd-spacing.md").replace("Three blank lines above.", "Three  blank   lines, edited by hand.");
    const back = openMarkdown(edited);
    expect(back.save(back.doc)).toBe(edited);
  });
});
