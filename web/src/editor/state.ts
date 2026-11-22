// The rich editor's state, without a browser: Markdown loaded into a
// ProseMirror EditorState with the editor's plugins, the commands its toolbar
// and keys run, and the Markdown it saves. The shared component
// (web/src/ui/rich-editor.tsx) mounts a view over this; the round-trip suite
// drives it headlessly.
//
// Every edit is a transaction on the state loaded once from the Markdown, so
// the blocks no edit touched stay the very nodes they were loaded as, and
// saving writes them back byte for byte (see round-trip.ts). Only switching
// to the Markdown source and back loads the Markdown again.
import { baseKeymap, chainCommands, exitCode, lift, setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import { dropCursor } from "prosemirror-dropcursor";
import { gapCursor } from "prosemirror-gapcursor";
import { history, redo, undo } from "prosemirror-history";
import { InputRule, inputRules, textblockTypeInputRule, undoInputRule, wrappingInputRule } from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import { Fragment, Slice, type Attrs, type MarkType, type Node, type NodeType, type ResolvedPos } from "prosemirror-model";
import { liftListItem, sinkListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
import { EditorState, TextSelection, type Command, type Plugin, type Transaction } from "prosemirror-state";
import { addColumnAfter, addRowAfter, deleteColumn, deleteRow, goToNextCell, isInTable, tableEditing } from "prosemirror-tables";
import { markdownParser, markdownSerializer } from "./markdown.js";
import { embedAddress } from "./embed-address.js";
import { embedNode, openMarkdown, type MarkdownDocument } from "./round-trip.js";
import { schema } from "./schema.js";

const nodes = schema.nodes as Record<string, NodeType>;
const marks = schema.marks as Record<string, MarkType>;

/** Markdown loaded for editing: the opened document and the state edits start from. */
export interface Draft {
  readonly opened: MarkdownDocument;
  readonly state: EditorState;
}

/** What the view adds to the state's keys: opening the link dialog, which needs the page. */
export interface EditorHooks {
  /** Asks for a link's address, as Mod-K does. */
  editLink?: () => void;
}

/** Loads Markdown for editing. */
export function openDraft(markdown: string, hooks: EditorHooks = {}): Draft {
  const opened = openMarkdown(markdown);
  return { opened, state: EditorState.create({ doc: opened.doc, plugins: editorPlugins(hooks) }) };
}

/** The Markdown a state saves: the loaded blocks no edit touched as they were written, the rest in Cronk's style. */
export function markdownOf(draft: Pick<Draft, "opened">, state: EditorState): string {
  return draft.opened.save(state.doc);
}

// ---- Reading the selection, for the toolbar's pressed buttons ----

export function markActive(state: EditorState, type: MarkType): boolean {
  const { from, $from, to, empty } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks ?? $from.marks());
  return state.doc.rangeHasMark(from, to, type);
}

/** Whether the selection's textblock is of this type, with these attributes. */
export function blockActive(state: EditorState, type: NodeType, attrs: Attrs = {}): boolean {
  const parent = state.selection.$from.parent;
  return parent.type === type && Object.entries(attrs).every(([key, value]) => parent.attrs[key] === value);
}

/** The depth of the nearest ancestor of this type around the selection's start, or null. */
function ancestorDepth($pos: ResolvedPos, type: NodeType): number | null {
  for (let depth = $pos.depth; depth > 0; depth--) if ($pos.node(depth).type === type) return depth;
  return null;
}

/** The nearest list around the selection: its type and whether its items are tasks. */
export function listAround(state: EditorState): { type: NodeType; task: boolean } | null {
  const $from = state.selection.$from;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type === nodes.bullet_list || node.type === nodes.ordered_list) {
      return { type: node.type, task: node.firstChild?.attrs.checked != null };
    }
  }
  return null;
}

export function inAncestor(state: EditorState, type: NodeType): boolean {
  return ancestorDepth(state.selection.$from, type) !== null;
}

// ---- Commands ----

export const toggleBold = toggleMark(marks.strong!);
export const toggleItalic = toggleMark(marks.em!);
export const toggleStrikethrough = toggleMark(marks.strikethrough!);
export const toggleInlineCode = toggleMark(marks.code!);

/** Makes the selection's textblock a heading of this level, or a paragraph again when it already is one. */
export function toggleHeading(level: number): Command {
  return (state, dispatch) =>
    blockActive(state, nodes.heading!, { level })
      ? setBlockType(nodes.paragraph!)(state, dispatch)
      : setBlockType(nodes.heading!, { level })(state, dispatch);
}

/** Makes the selection's textblock a code block, or a paragraph again when it already is one. */
export const toggleCodeBlock: Command = (state, dispatch) =>
  blockActive(state, nodes.code_block!)
    ? setBlockType(nodes.paragraph!)(state, dispatch)
    : setBlockType(nodes.code_block!)(state, dispatch);

/** Wraps the selection in a quote, or lifts it out of the quote it's in. */
export const toggleQuote: Command = (state, dispatch) =>
  inAncestor(state, nodes.blockquote!) ? lift(state, dispatch) : wrapIn(nodes.blockquote!)(state, dispatch);

/** Sets `checked` on every item of the list the selection is in. */
function markItems(tr: Transaction, checked: boolean | null): Transaction {
  const $from = tr.selection.$from;
  for (let depth = $from.depth; depth > 0; depth--) {
    const list = $from.node(depth);
    if (list.type !== nodes.bullet_list && list.type !== nodes.ordered_list) continue;
    const start = $from.start(depth);
    list.forEach((item, offset) => {
      if (item.attrs.checked === null || checked === null) {
        tr.setNodeMarkup(start + offset, null, { ...item.attrs, checked: checked === null ? null : (item.attrs.checked ?? checked) });
      }
    });
    return tr;
  }
  return tr;
}

/**
 * A list of this kind around the selection: wraps it in one, turns the list it's in into this kind, or lifts it out of
 * a list that already is.
 */
function toggleList(kind: "bullet" | "ordered" | "task"): Command {
  const type = kind === "ordered" ? nodes.ordered_list! : nodes.bullet_list!;
  return (state, dispatch) => {
    const around = listAround(state);
    if (around && around.type === type && around.task === (kind === "task")) return liftListItem(nodes.list_item!)(state, dispatch);
    if (around) {
      if (!dispatch) return true;
      const $from = state.selection.$from;
      let depth = $from.depth;
      while (depth > 0 && $from.node(depth).type !== around.type) depth--;
      const tr = state.tr;
      if (around.type !== type) tr.setNodeMarkup($from.before(depth), type);
      dispatch(markItems(tr, kind === "task" ? false : null).scrollIntoView());
      return true;
    }
    let wrapped: Transaction | null = null;
    if (!wrapInList(type)(state, (tr) => (wrapped = tr))) return false;
    if (dispatch) dispatch(markItems(wrapped!, kind === "task" ? false : null).scrollIntoView());
    return true;
  };
}

export const toggleBulletList = toggleList("bullet");
export const toggleOrderedList = toggleList("ordered");
export const toggleTaskList = toggleList("task");

/** Ticks or unticks the task item the selection is in. */
export const toggleTask: Command = (state, dispatch) => {
  const $from = state.selection.$from;
  const depth = ancestorDepth($from, nodes.list_item!);
  if (depth === null) return false;
  const item = $from.node(depth);
  if (item.attrs.checked === null) return false;
  dispatch?.(state.tr.setNodeMarkup($from.before(depth), null, { ...item.attrs, checked: !item.attrs.checked }));
  return true;
};

/** Ticks or unticks the task item at this position, as clicking its box does. */
export function setTaskAt(pos: number, checked: boolean): Command {
  return (state, dispatch) => {
    const item = state.doc.nodeAt(pos);
    if (!item || item.type !== nodes.list_item || item.attrs.checked === null) return false;
    dispatch?.(state.tr.setNodeMarkup(pos, null, { ...item.attrs, checked }));
    return true;
  };
}

/** A horizontal rule after the selection's block, with the cursor in a paragraph after it. */
export const insertRule: Command = (state, dispatch) => {
  const { $from } = state.selection;
  const at = $from.depth > 0 ? $from.after(1) : $from.pos;
  if (dispatch) {
    const tr = state.tr.insert(at, [nodes.horizontal_rule!.create(), nodes.paragraph!.create()]);
    dispatch(tr.setSelection(TextSelection.create(tr.doc, at + 2)).scrollIntoView());
  }
  return true;
};

/** A table of two columns, a header row and one more row, after the selection's block. */
export const insertTable: Command = (state, dispatch) => {
  if (isInTable(state)) return false;
  const { $from } = state.selection;
  const at = $from.depth > 0 ? $from.after(1) : $from.pos;
  if (dispatch) {
    const row = (cell: NodeType) => nodes.table_row!.create(null, [cell.create(), cell.create()]);
    const table = nodes.table!.create(null, [row(nodes.table_header!), row(nodes.table_cell!)]);
    const tr = state.tr.insert(at, table);
    dispatch(tr.setSelection(TextSelection.create(tr.doc, at + 3)).scrollIntoView());
  }
  return true;
};

export { addColumnAfter, addRowAfter, deleteColumn, deleteRow, isInTable, redo, undo };

/** The range of the link around a position, the run of text carrying the same link mark, if there is one. */
function linkRange(state: EditorState, pos: number): { from: number; to: number; href: string } | null {
  const $pos = state.doc.resolve(pos);
  const start = $pos.start();
  const runs: { from: number; to: number; mark: ReturnType<MarkType["create"]> }[] = [];
  $pos.parent.forEach((child, offset) => {
    const mark = marks.link!.isInSet(child.marks);
    const from = start + offset;
    const to = from + child.nodeSize;
    const last = runs.at(-1);
    if (mark && last && last.to === from && last.mark.eq(mark)) last.to = to;
    else if (mark) runs.push({ from, to, mark });
  });
  const run = runs.find((r) => r.from <= pos && pos <= r.to);
  return run ? { from: run.from, to: run.to, href: String(run.mark.attrs.href) } : null;
}

/** The address of the link the selection is in, if any, for the link dialog to start from. */
export function linkAt(state: EditorState): string | null {
  if (!state.selection.empty) {
    let href: string | null = null;
    state.doc.nodesBetween(state.selection.from, state.selection.to, (node) => {
      const mark = marks.link!.isInSet(node.marks);
      if (mark) href ??= String(mark.attrs.href);
    });
    return href;
  }
  return linkRange(state, state.selection.from)?.href ?? null;
}

/**
 * Links the selection to an address; with nothing selected, the link the cursor is in, or else the address itself
 * as new linked text. An empty address removes the link.
 */
export function setLink(href: string): Command {
  return (state, dispatch) => {
    const link = marks.link!;
    let { from, to, empty } = state.selection;
    if (empty) {
      const range = linkRange(state, from);
      if (range) ({ from, to } = range);
    }
    if (!dispatch) return true;
    const tr = state.tr;
    if (!href.trim()) {
      if (from !== to) tr.removeMark(from, to, link);
      dispatch(tr);
      return true;
    }
    if (from === to) {
      tr.insert(from, schema.text(href, [link.create({ href })]));
    } else {
      tr.removeMark(from, to, link).addMark(from, to, link.create({ href }));
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

// ---- Markdown shortcuts as one types ----

/** `**bold**`, `*italic*`, `` `code` `` and `~~struck~~` as their closing delimiter is typed. */
function markRule(pattern: RegExp, type: MarkType, delimiter: string): InputRule {
  return new InputRule(pattern, (state, match, start, end) => {
    const whole = match[0];
    const text = match[1]!;
    // The match ends with the closing delimiter's last character, which is being typed and isn't in the document yet.
    const textEnd = start + whole.length - delimiter.length;
    const textStart = textEnd - text.length;
    const openStart = textStart - delimiter.length;
    const tr = state.tr.delete(textEnd, end).delete(openStart, textStart);
    tr.addMark(openStart, openStart + text.length, type.create());
    tr.removeStoredMark(type);
    return tr;
  });
}

function taskRule(): InputRule {
  return new InputRule(/^\[([ xX])\]\s$/, (state, match, start, end) => {
    const $start = state.doc.resolve(start);
    const depth = $start.depth - 1;
    if (depth < 1) return null;
    const item = $start.node(depth);
    if (item.type !== nodes.list_item || item.attrs.checked !== null || $start.index(depth) !== 0) return null;
    return state.tr.delete(start, end).setNodeMarkup($start.before(depth), null, { ...item.attrs, checked: match[1] !== " " });
  });
}

function ruleRule(): InputRule {
  return new InputRule(/^(?:---|\*\*\*|___)$/, (state, _match, start, end) => {
    const $start = state.doc.resolve(start);
    if ($start.parent.type !== nodes.paragraph || $start.parent.content.size !== end - start) return null;
    const tr = state.tr;
    const before = $start.before();
    tr.replaceWith(before, $start.after(), [nodes.horizontal_rule!.create(), nodes.paragraph!.create()]);
    return tr.setSelection(TextSelection.create(tr.doc, before + 2));
  });
}

function markdownShortcuts(): Plugin {
  return inputRules({
    rules: [
      textblockTypeInputRule(/^(#{1,6})\s$/, nodes.heading!, (match) => ({ level: match[1]!.length })),
      wrappingInputRule(/^\s*>\s$/, nodes.blockquote!),
      wrappingInputRule(/^\s*([-+*])\s$/, nodes.bullet_list!, (match) => ({ bullet: match[1] })),
      wrappingInputRule(
        /^(\d+)\.\s$/,
        nodes.ordered_list!,
        (match) => ({ order: Number(match[1]) }),
        (match, node) => node.childCount + node.attrs.order === Number(match[1]),
      ),
      taskRule(),
      textblockTypeInputRule(/^```([\w-]*)\s$/, nodes.code_block!, (match) => ({ params: match[1] ?? "" })),
      ruleRule(),
      markRule(/\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/, marks.strong!, "**"),
      markRule(/(?:^|[^*\w])\*([^*\s](?:[^*]*[^*\s])?)\*$/, marks.em!, "*"),
      markRule(/(?:^|[^_\w])_([^_\s](?:[^_]*[^_\s])?)_$/, marks.em!, "_"),
      markRule(/`([^`]+)`$/, marks.code!, "`"),
      markRule(/~~([^~\s](?:[^~]*[^~\s])?)~~$/, marks.strikethrough!, "~~"),
    ],
  });
}

// ---- Keys ----

/** Enter in a table cell, which Markdown keeps to one line, does nothing rather than split the cell. */
const stayInCell: Command = (state) => isInTable(state);

const hardBreak: Command = (state, dispatch) => {
  dispatch?.(state.tr.replaceSelectionWith(nodes.hard_break!.create()).scrollIntoView());
  return true;
};

/**
 * The editor's keys. Tab moves between table cells and nests list items, and otherwise leaves the editor, as Tab
 * leaves any field, so the keyboard is never trapped.
 */
export function editorKeys(hooks: EditorHooks = {}): Record<string, Command> {
  const item = nodes.list_item!;
  return {
    "Mod-z": undo,
    "Shift-Mod-z": redo,
    "Mod-y": redo,
    Backspace: undoInputRule,
    "Mod-b": toggleBold,
    "Mod-i": toggleItalic,
    "Mod-e": toggleInlineCode,
    "Mod-Shift-x": toggleStrikethrough,
    "Mod-k": (_state, dispatch) => {
      if (!hooks.editLink) return false;
      if (dispatch) hooks.editLink();
      return true;
    },
    "Mod-Alt-0": setBlockType(nodes.paragraph!),
    "Mod-Alt-1": toggleHeading(1),
    "Mod-Alt-2": toggleHeading(2),
    "Mod-Alt-3": toggleHeading(3),
    "Mod-Alt-c": toggleCodeBlock,
    "Mod-Shift-7": toggleOrderedList,
    "Mod-Shift-8": toggleBulletList,
    "Mod-Shift-9": toggleTaskList,
    "Mod-Shift-b": toggleQuote,
    "Mod-Shift-Enter": toggleTask,
    "Shift-Enter": chainCommands(exitCode, hardBreak),
    Enter: chainCommands(stayInCell, splitListItem(item)),
    Tab: chainCommands(goToNextCell(1), sinkListItem(item)),
    "Shift-Tab": chainCommands(goToNextCell(-1), liftListItem(item)),
  };
}

// ---- Clipboard ----

/** Plain text pasted is read as Markdown, so pasted Markdown arrives formatted. */
export function sliceFromText(text: string, $context: ResolvedPos): Slice {
  if ($context.parent.type.spec.code) return new Slice(Fragment.from(schema.text(text)), 0, 0);
  const parsed = stripBlocks(markdownParser.parse(text));
  // An address pasted on a line of its own at the top level is an Embed; in a sentence, or nested, it stays text.
  const ownLine = $context.depth <= 1 && (parsed.childCount > 1 || $context.parent.content.size === 0);
  return Slice.maxOpen(ownLine ? Fragment.from(mapChildren(parsed).map(asEmbed)) : parsed.content);
}

/**
 * A pasted paragraph holding an Artifact's address alone, bare or as an autolink, as its Embed; any other node as it
 * is. The tokenizer reads no bare links, so a bare address is plain text here.
 */
function asEmbed(node: Node): Node {
  if (node.type !== nodes.paragraph || node.childCount !== 1) return node;
  const only = node.firstChild!;
  if (!only.isText) return node;
  const text = only.text!;
  const link = only.marks.find((mark) => mark.type === marks.link);
  const plain = only.marks.length === 0;
  const autolink = link !== undefined && only.marks.length === 1 && link.attrs.href === text;
  if ((!plain && !autolink) || !embedAddress(text.trim())) return node;
  return embedNode(text.trim(), autolink ? `<${text}>` : text.trim());
}

/** Clears the loaded-block marks, so pasted blocks save as new ones. */
function stripBlocks(doc: Node): Node {
  return doc.type.create(
    doc.attrs,
    Fragment.from(mapChildren(doc)),
  );
}

function mapChildren(node: Node): Node[] {
  const children: Node[] = [];
  node.forEach((child) => {
    children.push("block" in child.attrs ? child.type.create({ ...child.attrs, block: null }, child.content, child.marks) : child);
  });
  return children;
}

/** What copying puts on the clipboard as plain text: the selection's Markdown. */
export function textFromSlice(slice: Slice): string {
  try {
    const content = slice.content.firstChild?.isInline ? Fragment.from(nodes.paragraph!.create(null, slice.content)) : slice.content;
    return markdownSerializer.serialize(nodes.doc!.create(null, content)).replace(/\n+$/, "");
  } catch {
    return slice.content.textBetween(0, slice.content.size, "\n\n");
  }
}

/** An address pasted alone, which links selected text rather than replacing it. */
export function isAddress(text: string): boolean {
  return /^(?:https?:\/\/|mailto:|attachment:)\S+$/i.test(text.trim());
}

/** Inserts Markdown, such as an Attachment's reference, at a position: inline in a paragraph, as text in code. */
export function insertMarkdown(markdown: string, pos?: number): Command {
  return (state, dispatch) => {
    const at = pos ?? state.selection.from;
    const $at = state.doc.resolve(at);
    if (!dispatch) return true;
    const tr = state.tr;
    if ($at.parent.type.spec.code) {
      tr.insertText(markdown, at);
    } else {
      const parsed = stripBlocks(markdownParser.parse(markdown));
      const only = parsed.childCount === 1 ? parsed.firstChild! : null;
      if ($at.parent.inlineContent && only && only.type === nodes.paragraph) tr.insert(at, only.content);
      else tr.insert($at.depth > 0 ? $at.after(1) : at, parsed.content);
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** Every plugin the editor runs with, in order. */
export function editorPlugins(hooks: EditorHooks = {}): Plugin[] {
  return [
    markdownShortcuts(),
    keymap(editorKeys(hooks)),
    keymap(baseKeymap),
    history(),
    tableEditing(),
    gapCursor(),
    dropCursor({ class: "rich-editor-drop" }),
  ];
}
