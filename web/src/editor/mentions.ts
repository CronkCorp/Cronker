// Mentions while editing: the Ticket and Decision keys and Term names a draft
// holds show as links, the way readers will see them, and typing a key or the
// start of a Term's name offers a picker of what it may mention.
//
// Both are views only. The links are inline decorations over the text, and
// picking inserts the key or name as plain text, so the document, and so the
// Markdown saved, is exactly what was typed.
import type { Node } from "prosemirror-model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { DecisionMention, TermMention, TicketMention } from "../api.js";

/** A Mention written in the text: a Ticket's or a Decision's key, or a Term's name. */
export type KeyMention = TicketMention | DecisionMention | TermMention;

/** The page a Mention leads to, as the reading side builds it. */
export type MentionAddress = (mention: KeyMention) => string;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The pattern finding the Mentions' texts, with the reading side's boundaries (`web/src/markdown.tsx`): a Ticket key
 * as a word, a Decision key not inside a longer word or key nor before `-3`, a Term's name as a whole word, the
 * longest first.
 */
export function mentionPattern(mentions: KeyMention[]): RegExp | null {
  if (mentions.length === 0) return null;
  const alternation = (kind: KeyMention["kind"]) =>
    [...new Set(mentions.filter((m) => m.kind === kind).map((m) => m.text))]
      .sort((a, b) => b.length - a.length)
      .map(escape)
      .join("|") || "(?!)";
  return new RegExp(
    `\\b(?:${alternation("ticket")})\\b|(?<![\\w-])(?:${alternation("decision")})(?!\\w|-[1-9])` +
      `|(?<![\\p{L}\\p{N}_])(?:${alternation("term")})(?![\\p{L}\\p{N}_])`,
    "gu",
  );
}

/** Where a Mention is written in the document. */
export interface MentionRange {
  from: number;
  to: number;
  mention: KeyMention;
}

/** Whether text here is read as a Mention: not in code, a source block or a link, whose text already leads somewhere. */
function plainText(node: Node, parent: Node | null): boolean {
  if (parent?.type.spec.code) return false;
  return !node.marks.some((mark) => mark.type.name === "code" || mark.type.name === "link");
}

/** Each place the document writes one of these Mentions, outside code and links, in order. */
export function mentionRanges(doc: Node, mentions: KeyMention[]): MentionRange[] {
  const pattern = mentionPattern(mentions);
  if (!pattern) return [];
  const byText = new Map(mentions.map((m) => [m.text, m]));
  const ranges: MentionRange[] = [];
  doc.descendants((node, pos, parent) => {
    if (node.type.spec.code) return false;
    if (!node.isText || !plainText(node, parent)) return true;
    for (const match of node.text!.matchAll(pattern)) {
      const mention = byText.get(match[0]);
      if (mention) ranges.push({ from: pos + match.index, to: pos + match.index + match[0].length, mention });
    }
    return false;
  });
  return ranges;
}

// ---- The word being typed, for the picker ----

/** The word before the cursor that the picker offers Mentions for, and where it is. */
export interface TypedWord {
  from: number;
  to: number;
  text: string;
}

/** A word of letters, digits, underscores and hyphens, after no such character, ending at the cursor. */
const wordBefore = /(?<![\p{L}\p{N}_-])[\p{L}\p{N}_][\p{L}\p{N}_-]*$/u;

/**
 * The word being typed: the one ending at an empty selection, in plain text (not code, a source block or a link),
 * that could start a Mention: a Project's key and a hyphen, maybe with a number (`WEB-`, `WEB-D3`), a Project's key in
 * capitals, `D` and a number, or two or more characters that may start a Term's name. Null anywhere else.
 */
export function typedWord(state: EditorState): TypedWord | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const $at = selection.$from;
  const parent = $at.parent;
  if (!parent.isTextblock || parent.type.spec.code) return null;
  const before = $at.nodeBefore;
  if (!before?.isText || !plainText(before, parent)) return null;
  // The cursor at a word's end, not inside one.
  const after = $at.nodeAfter;
  if (after?.isText && /^[\p{L}\p{N}_-]/u.test(after.text!)) return null;
  const match = wordBefore.exec(before.text!);
  if (!match) return null;
  const text = match[0];
  if ([...text].length < 2 || [...text].length > 60) return null;
  return { from: $at.pos - text.length, to: $at.pos, text };
}

/** Replaces the word typed with what was picked: plain text, with the marks around it, so the Markdown is just it. */
export function pickMention(state: EditorState, word: TypedWord, text: string): Transaction {
  return state.tr.insertText(text, word.from, word.to).scrollIntoView();
}

// ---- The plugin ----

interface MentionState {
  mentions: KeyMention[];
  decorations: DecorationSet;
  /** Where the word the User dismissed the picker for starts, until they type elsewhere. */
  dismissedAt: number | null;
}

export const mentionsKey = new PluginKey<MentionState>("mentions");

type Meta = { mentions: KeyMention[] } | { dismiss: number | null };

function decorate(doc: Node, mentions: KeyMention[], address: MentionAddress): DecorationSet {
  const ranges = mentionRanges(doc, mentions);
  if (ranges.length === 0) return DecorationSet.empty;
  return DecorationSet.create(
    doc,
    ranges.map(({ from, to, mention }) =>
      Decoration.inline(from, to, {
        nodeName: "a",
        class: "mention",
        href: address(mention),
        title: `${mentionTitle(mention)}: Ctrl or ⌘ and click to open`,
        "data-mention": mention.kind,
      }),
    ),
  );
}

/** What a Mention's link names, for its tooltip. */
function mentionTitle(mention: KeyMention): string {
  if (mention.kind === "ticket") return `Ticket ${mention.key}`;
  if (mention.kind === "decision") return `Decision ${mention.key}`;
  return `Term ${mention.name}`;
}

/** Gives the plugin the Mentions found for the draft, as the API resolves them. */
export function setMentions(tr: Transaction, mentions: KeyMention[]): Transaction {
  return tr.setMeta(mentionsKey, { mentions } satisfies Meta);
}

/** Dismisses the picker for the word starting here, or ends a dismissal (null). */
export function dismissPicker(tr: Transaction, at: number | null): Transaction {
  return tr.setMeta(mentionsKey, { dismiss: at } satisfies Meta);
}

/** The Mentions the plugin links now. */
export function mentionsOf(state: EditorState): KeyMention[] {
  return mentionsKey.getState(state)?.mentions ?? [];
}

/** The word the picker is open for, unless the User dismissed it. */
export function pickerWord(state: EditorState): TypedWord | null {
  const word = typedWord(state);
  if (!word) return null;
  return mentionsKey.getState(state)?.dismissedAt === word.from ? null : word;
}

/**
 * Links the Mentions the draft holds, by the list last given with `setMentions`, wherever their text is written
 * outside code and links, again after every edit; and remembers a dismissed picker.
 */
export function mentionsPlugin(address: MentionAddress): Plugin<MentionState> {
  return new Plugin<MentionState>({
    key: mentionsKey,
    state: {
      init: () => ({ mentions: [], decorations: DecorationSet.empty, dismissedAt: null }),
      apply(tr, value, _old, state) {
        const meta = tr.getMeta(mentionsKey) as Meta | undefined;
        let { mentions, decorations, dismissedAt } = value;
        if (meta && "mentions" in meta) {
          mentions = meta.mentions;
          decorations = decorate(state.doc, mentions, address);
        } else if (tr.docChanged) {
          decorations = decorate(state.doc, mentions, address);
        }
        if (meta && "dismiss" in meta) dismissedAt = meta.dismiss;
        else if (dismissedAt !== null && (tr.docChanged || tr.selectionSet)) {
          const mapped = tr.mapping.map(dismissedAt);
          dismissedAt = typedWord(state)?.from === mapped ? mapped : null;
        }
        return { mentions, decorations, dismissedAt };
      },
    },
    props: {
      decorations: (state) => mentionsKey.getState(state)?.decorations,
    },
  });
}
