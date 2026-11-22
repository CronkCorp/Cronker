// Markdown in, editor document out, and back: byte for byte for every block
// the User didn't edit.
//
// No Markdown library keeps untouched text byte for byte: each parses to a
// tree and writes it back in its own style. So the editor keeps each block's
// own Markdown itself. Loading splits the text into its top-level blocks with
// their exact source and the exact text between them. Each block becomes one
// editor node; the node object is the one ProseMirror keeps for as long as no
// edit touches that block, since its documents are persistent. Saving writes a
// block whose node is still the one loaded as its original source, and only a
// block whose node changed through the serialiser, in Cronk's style. Blocks
// the editor can't show (raw HTML, footnotes, link definitions and the like)
// become source blocks, edited as their Markdown text. An Artifact's address
// alone in its paragraph becomes an Embed, one block kept as written.
import type { Nodes, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { Node } from "prosemirror-model";
import { embedIn } from "./embed-address.js";
import { markdownParser, markdownSerializer } from "./markdown.js";
import { schema } from "./schema.js";

export interface MarkdownDocument {
  /** The editor document, one top-level node per block of the Markdown. */
  readonly doc: Node;
  /** Where each top-level node of `doc` came from in the Markdown. */
  readonly blocks: readonly { from: number; to: number }[];
  /** The Markdown for `doc` or any document edited from it. */
  save(doc: Node): string;
}

// mdast node types the editor shows as formatted text. A block holding any
// other kind of node, at any depth, is kept as a source block.
const shown = new Set([
  "paragraph",
  "heading",
  "thematicBreak",
  "blockquote",
  "list",
  "listItem",
  "code",
  "table",
  "tableRow",
  "tableCell",
  "text",
  "emphasis",
  "strong",
  "delete",
  "inlineCode",
  "break",
  "link",
  "image",
  "linkReference",
  "imageReference",
]);

function onlyShown(node: Nodes): boolean {
  if (!shown.has(node.type)) return false;
  return !("children" in node) || node.children.every((child) => onlyShown(child));
}

function serialiseBlock(node: Node): string {
  return markdownSerializer.serialize(schema.nodes.doc!.create(null, node)).replace(/\n+$/, "");
}

// The block as a formatted editor node, or null when the editor can't show
// it faithfully: it isn't one node, or writing it and reading it back doesn't
// give the same node.
function formatted(source: string, env: object): Node | null {
  try {
    const parsed = markdownParser.parse(source, env);
    const node = parsed.childCount === 1 ? parsed.firstChild : null;
    if (!node) return null;
    const again = markdownParser.parse(serialiseBlock(node), env);
    return again.childCount === 1 && again.firstChild!.eq(node) ? node : null;
  } catch {
    return null;
  }
}

/** An Embed of the address a paragraph holds alone, written as `markdown`. */
export function embedNode(address: string, markdown: string): Node {
  return schema.nodes.embed!.create({ address, markdown });
}

/** The block as an Embed, when it is a paragraph holding an Artifact's address alone. */
function embedded(node: RootContent, source: string): Node | null {
  if (node.type !== "paragraph") return null;
  const address = embedIn(source);
  return address === undefined ? null : embedNode(address, source.trim());
}

function sourceBlock(source: string): Node {
  const text = source.replace(/\r\n?/g, "\n");
  return schema.nodes.source_block!.create(null, text ? schema.text(text) : null);
}

function topLevel(markdown: string): RootContent[] {
  return fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }).children;
}

export function openMarkdown(markdown: string): MarkdownDocument {
  const eol = /\r\n/.test(markdown) ? "\r\n" : "\n";
  const env = {};
  markdownParser.tokenizer.parse(markdown, env);

  const blocks = topLevel(markdown).map((node) => ({
    from: node.position!.start.offset!,
    to: node.position!.end.offset!,
    node,
  }));
  const sources = blocks.map(({ from, to }) => markdown.slice(from, to));
  const originals = blocks.map(({ node }, i) => {
    const source = sources[i]!;
    const shownNode = embedded(node, source) ?? (onlyShown(node) ? formatted(source, env) : null);
    const loaded = shownNode ?? sourceBlock(source);
    return loaded.type.create({ ...loaded.attrs, block: i }, loaded.content, loaded.marks);
  });
  const leading = blocks.length ? markdown.slice(0, blocks[0]!.from) : markdown;
  const trailing = blocks.length ? markdown.slice(blocks.at(-1)!.to) : "";
  const between = blocks.slice(1).map((block, i) => markdown.slice(blocks[i]!.to, block.from));

  const doc = schema.nodes.doc!.create(null, originals.length ? originals : schema.nodes.paragraph!.create());

  return {
    doc,
    blocks: blocks.map(({ from, to }) => ({ from, to })),
    save(edited) {
      let out = leading;
      let previous: number | null | undefined;
      edited.forEach((node) => {
        const index: number | null = node.attrs.block ?? null;
        const text =
          index !== null && originals[index] === node
            ? sources[index]!
            : serialiseBlock(node).replace(/\n/g, eol);
        if (text === "") return;
        if (previous !== undefined) {
          // Keep the original text between two blocks still next to each
          // other, edited or not; a new or moved block gets one blank line.
          out += previous !== null && index === previous + 1 ? between[previous]! : eol + eol;
        }
        out += text;
        previous = index;
      });
      return out + trailing;
    },
  };
}
