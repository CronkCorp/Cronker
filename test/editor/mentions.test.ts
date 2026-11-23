// Mentions in the editor (CRONK-23): the draft's Mentions show as links over
// its text, and the picker replaces the word typed with plain text, so the
// Markdown saved is exactly what was written.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TextSelection } from "prosemirror-state";
import { describe, expect, test } from "vitest";
import {
  dismissPicker,
  mentionRanges,
  pickerWord,
  pickMention,
  setMentions,
  typedWord,
  type KeyMention,
} from "../../web/src/editor/mentions.js";
import { markdownOf, openDraft, type Draft } from "../../web/src/editor/state.js";

const sample = readFileSync(join(import.meta.dirname, "samples/mentions.md"), "utf8");

const ticket = (key: string, text = key): KeyMention => ({ kind: "ticket", text, key, ticketId: "00000000-0000-4000-8000-000000000001" });
const decision = (key: string): KeyMention => ({
  kind: "decision",
  text: key,
  key,
  decisionId: "00000000-0000-4000-8000-000000000002",
  projectId: null,
  number: 3,
});
const term = (name: string): KeyMention => ({
  kind: "term",
  text: name,
  termId: "00000000-0000-4000-8000-000000000003",
  name,
  projectId: null,
});

const mentions = [
  ticket("CRONK-12"),
  ticket("CRONK-21"),
  ticket("CRONK-5"),
  ticket("CRONK-6"),
  ticket("WEB-D7-2"),
  decision("CRONK-D3"),
  decision("D7"),
  term("Delegation"),
  term("Landing page"),
];

const open = (markdown: string): Draft => openDraft(markdown, { mentionAddress: (m) => `/acme/${m.kind}/${m.text}` });

/** The text each link covers, in order. */
function linked(draft: Draft, state = draft.state) {
  return mentionRanges(state.doc, mentions).map(({ from, to }) => state.doc.textBetween(from, to));
}

/** The draft with the cursor at the end of the text given, written as the last paragraph. */
function typing(text: string) {
  const draft = open(`Before.\n\n${text}`);
  const end = draft.state.doc.content.size - 1;
  return { draft, state: draft.state.apply(draft.state.tr.setSelection(TextSelection.create(draft.state.doc, end))) };
}

describe("Mention links while editing", () => {
  test("link each kind of Mention where written, outside code and links, with the reading side's boundaries", () => {
    const draft = open(sample);
    expect(linked(draft)).toEqual(["CRONK-12", "Delegation", "CRONK-21", "CRONK-D3", "D7", "WEB-D7-2", "Landing page"]);
  });

  test("are decorations only: the draft with its Mentions given saves byte for byte", () => {
    const draft = open(sample);
    const state = draft.state.apply(setMentions(draft.state.tr, mentions));
    expect(markdownOf(draft, state)).toBe(sample);
    expect(state.doc.eq(draft.state.doc)).toBe(true);
  });

  test("follow the text as it is edited", () => {
    const draft = open("See CRONK-12.");
    let state = draft.state.apply(setMentions(draft.state.tr, mentions));
    state = state.apply(state.tr.insertText("Now ", 1));
    expect(linked(draft, state)).toEqual(["CRONK-12"]);
    expect(markdownOf(draft, state)).toBe("Now See CRONK-12.");
  });
});

describe("the Mention picker", () => {
  test("opens for the word typed before the cursor, in plain text only", () => {
    expect(typedWord(typing("See CRONK-").state)?.text).toBe("CRONK-");
    expect(typedWord(typing("See Lan").state)?.text).toBe("Lan");
    expect(typedWord(typing("See L").state)).toBeNull();
    expect(typedWord(typing("See `CRONK-`").state)).toBeNull();
    expect(typedWord(typing("```\nCRONK-\n```").state)).toBeNull();
  });

  test("picking inserts the key or name as plain text, and saves it as such", () => {
    const { draft, state } = typing("See CRONK-");
    const word = typedWord(state)!;
    const picked = state.apply(pickMention(state, word, "CRONK-12"));
    expect(markdownOf(draft, picked)).toBe("Before.\n\nSee CRONK-12");

    // In bold text, the name picked is bold too.
    const bold = typing("See **Lan**");
    expect(markdownOf(bold.draft, bold.state.apply(pickMention(bold.state, typedWord(bold.state)!, "Landing page")))).toBe(
      "Before.\n\nSee **Landing page**",
    );
  });

  test("stays closed for a word dismissed, until the cursor leaves it", () => {
    const { state } = typing("See CRONK-");
    const word = pickerWord(state)!;
    let next = state.apply(dismissPicker(state.tr, word.from));
    expect(pickerWord(next)).toBeNull();
    next = next.apply(next.tr.insertText("1"));
    expect(pickerWord(next)).toBeNull();
    next = next.apply(next.tr.insertText(" and WEB-"));
    expect(pickerWord(next)?.text).toBe("WEB-");
  });
});
