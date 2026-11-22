// The rich editor's document schema: CommonMark's (prosemirror-markdown's),
// with GitHub's tables, task lists and strikethrough, and a source block
// holding Markdown the editor can't show as formatted text.
//
// Every block that can stand at the top of a document carries `block`: the
// index of the Markdown block it was loaded from, or null for one written in
// the editor. Saving uses it to keep the blank lines between blocks as they
// were (see round-trip.ts).
import { schema as commonmark } from "prosemirror-markdown";
import { Schema, type NodeSpec } from "prosemirror-model";

const block = { block: { default: null } };
// What prosemirror-tables reads of a cell. Markdown has no spans, so they stay 1.
const cellAttrs = { align: { default: null }, colspan: { default: 1 }, rowspan: { default: 1 }, colwidth: { default: null } };

function withBlock(name: string): NodeSpec {
  const spec = commonmark.spec.nodes.get(name);
  if (!spec) throw new Error(`prosemirror-markdown has no ${name} node`);
  return { ...spec, attrs: { ...spec.attrs, ...block } };
}

const listItem = commonmark.spec.nodes.get("list_item")!;
const bulletList = withBlock("bullet_list");

export const schema = new Schema({
  nodes: commonmark.spec.nodes
    .update("paragraph", withBlock("paragraph"))
    .update("heading", withBlock("heading"))
    .update("blockquote", withBlock("blockquote"))
    .update("code_block", withBlock("code_block"))
    .update("horizontal_rule", withBlock("horizontal_rule"))
    .update("ordered_list", withBlock("ordered_list"))
    .update("bullet_list", { ...bulletList, attrs: { ...bulletList.attrs, bullet: { default: "-" } } })
    // `checked` is null for a plain item, true or false for a task.
    .update("list_item", { ...listItem, attrs: { ...listItem.attrs, checked: { default: null } } })
    .addToEnd("table", {
      group: "block",
      content: "table_row+",
      isolating: true,
      attrs: block,
      tableRole: "table",
      parseDOM: [{ tag: "table" }],
      toDOM: () => ["table", ["tbody", 0]],
    })
    .addToEnd("table_row", {
      content: "(table_header | table_cell)+",
      tableRole: "row",
      parseDOM: [{ tag: "tr" }],
      toDOM: () => ["tr", 0],
    })
    .addToEnd("table_header", {
      content: "(text | image)*",
      attrs: cellAttrs,
      isolating: true,
      tableRole: "header_cell",
      parseDOM: [{ tag: "th", getAttrs: (dom) => ({ align: (dom as HTMLElement).style?.textAlign || null }) }],
      toDOM: (node) => ["th", { style: node.attrs.align ? `text-align: ${node.attrs.align}` : null }, 0],
    })
    .addToEnd("table_cell", {
      content: "(text | image)*",
      attrs: cellAttrs,
      isolating: true,
      tableRole: "cell",
      parseDOM: [{ tag: "td", getAttrs: (dom) => ({ align: (dom as HTMLElement).style?.textAlign || null }) }],
      toDOM: (node) => ["td", { style: node.attrs.align ? `text-align: ${node.attrs.align}` : null }, 0],
    })
    // Markdown the editor can't show, such as raw HTML or a footnote, kept as
    // its source text and edited as such.
    .addToEnd("source_block", {
      group: "block",
      content: "text*",
      marks: "",
      code: true,
      defining: true,
      attrs: block,
      // Before code_block's `pre`, so a copied source block pastes as one.
      parseDOM: [{ tag: "pre[data-source]", preserveWhitespace: "full", priority: 60 }],
      toDOM: () => ["pre", { "data-source": "" }, ["code", 0]],
    }),
  marks: commonmark.spec.marks.addToEnd("strikethrough", {
    parseDOM: [{ tag: "s" }, { tag: "del" }],
    toDOM: () => ["s", 0],
  }),
});
