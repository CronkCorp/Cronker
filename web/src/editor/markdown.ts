// Markdown to and from the editor's schema: markdown-it, through
// prosemirror-markdown, with GitHub's tables, task lists and strikethrough.
// This writes one block in Cronk's style; round-trip.ts decides which blocks
// are written this way and which keep the Markdown they were loaded from.
import MarkdownIt from "markdown-it";
import {
  defaultMarkdownParser,
  defaultMarkdownSerializer,
  MarkdownParser,
  MarkdownSerializer,
  type MarkdownSerializerState,
} from "prosemirror-markdown";
import type { Node } from "prosemirror-model";
import { schema } from "./schema.js";

const tokenizer = MarkdownIt("default", { html: false, linkify: false, typographer: false });

// A line break inside a paragraph stays a line break, so an edited paragraph
// keeps its lines rather than being joined into one.
tokenizer.core.ruler.push("cronk_softbreak", (state) => {
  for (const token of state.tokens) {
    for (const child of token.children ?? []) {
      if (child.type === "softbreak") {
        child.type = "text";
        child.content = "\n";
      }
    }
  }
});

// `- [ ] ` and `- [x] ` start a task list item.
tokenizer.core.ruler.push("cronk_task_items", (state) => {
  const tokens = state.tokens;
  tokens.forEach((token, i) => {
    if (token.type !== "list_item_open") return;
    const inline = tokens[i + 2];
    if (tokens[i + 1]?.type !== "paragraph_open" || inline?.type !== "inline") return;
    const match = /^\[([ xX])\](?:[ \t]+|$)/.exec(inline.content);
    const first = inline.children?.[0];
    if (!match || first?.type !== "text" || !first.content.startsWith(match[0])) return;
    token.meta = { ...token.meta, checked: match[1] !== " " };
    inline.content = inline.content.slice(match[0].length);
    first.content = first.content.slice(match[0].length);
  });
});

function alignment(style: string): string | null {
  return /text-align:\s*(left|center|right)/.exec(style)?.[1] ?? null;
}

const tokens = defaultMarkdownParser.tokens;

export const markdownParser = new MarkdownParser(schema, tokenizer, {
  ...tokens,
  bullet_list: {
    block: "bullet_list",
    getAttrs: (token, stream, i) => ({ ...tokens.bullet_list!.getAttrs!(token, stream, i), bullet: token.markup }),
  },
  list_item: { block: "list_item", getAttrs: (token) => ({ checked: token.meta?.checked ?? null }) },
  table: { block: "table" },
  thead: { ignore: true },
  tbody: { ignore: true },
  tr: { block: "table_row" },
  th: { block: "table_header", getAttrs: (token) => ({ align: alignment(String(token.attrGet("style") ?? "")) }) },
  td: { block: "table_cell", getAttrs: (token) => ({ align: alignment(String(token.attrGet("style") ?? "")) }) },
  s: { mark: "strikethrough" },
});

function inlineMarkdown(content: Node): string {
  const paragraph = schema.nodes.paragraph!.create(null, content.content);
  return markdownSerializer
    .serialize(schema.nodes.doc!.create(null, paragraph)).replace(/\n/g, " ").replace(/(?<!\\)\|/g, "\\|");
}

function delimiterRow(align: string | null): string {
  if (align === "left") return ":---";
  if (align === "center") return ":---:";
  if (align === "right") return "---:";
  return "---";
}

function writeTable(state: MarkdownSerializerState, table: Node) {
  const rows: string[] = [];
  table.forEach((row, _offset, i) => {
    const cells: string[] = [];
    row.forEach((cell) => cells.push(inlineMarkdown(cell)));
    rows.push(`| ${cells.join(" | ")} |`);
    if (i === 0) {
      const aligns: string[] = [];
      row.forEach((cell) => aligns.push(delimiterRow(cell.attrs.align)));
      rows.push(`| ${aligns.join(" | ")} |`);
    }
  });
  rows.forEach((row, i) => {
    if (i > 0) state.ensureNewLine();
    state.write(row);
  });
  state.closeBlock(table);
}

const nodes = defaultMarkdownSerializer.nodes;

export const markdownSerializer = new MarkdownSerializer(
  {
    ...nodes,
    bullet_list(state, node) {
      state.renderList(node, "  ", () => `${node.attrs.bullet || "-"} `);
    },
    list_item(state, node, parent, index) {
      if (node.attrs.checked !== null) state.write(node.attrs.checked ? "[x] " : "[ ] ");
      nodes.list_item!(state, node, parent, index);
    },
    table: writeTable,
    table_row() {},
    table_header() {},
    table_cell() {},
    embed(state, node) {
      state.write(node.attrs.markdown);
      state.closeBlock(node);
    },
    source_block(state, node) {
      state.text(node.textContent, false);
      state.closeBlock(node);
    },
  },
  {
    ...defaultMarkdownSerializer.marks,
    strikethrough: { open: "~~", close: "~~", mixable: true, expelEnclosingWhitespace: true },
  },
);
