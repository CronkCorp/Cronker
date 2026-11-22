// The rich editor as Documents use it (CRONK-21): Markdown loaded into the
// editor's state with all its plugins, edited through the commands its
// toolbar, keys and Markdown shortcuts run, and saved. See docs/testing.md,
// seam 8.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EditorState, TextSelection, type Command } from "prosemirror-state";
import { describe, expect, test } from "vitest";
import {
  addRowAfter,
  insertMarkdown,
  insertRule,
  insertTable,
  markdownOf,
  openDraft,
  setLink,
  sliceFromText,
  toggleBold,
  toggleBulletList,
  toggleHeading,
  toggleItalic,
  toggleQuote,
  toggleTask,
  toggleTaskList,
  undo,
  type Draft,
} from "../../web/src/editor/state.js";

const root = join(import.meta.dirname, "../..");

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? markdownFiles(join(dir, entry.name)) : entry.name.endsWith(".md") ? [join(dir, entry.name)] : [],
  );
}

const samples = [
  ...markdownFiles(join(import.meta.dirname, "samples")),
  join(root, "README.md"),
  join(root, "CONTEXT.md"),
  ...markdownFiles(join(root, "docs")),
].map((path) => ({ name: path.slice(root.length + 1), markdown: readFileSync(path, "utf8") }));

describe.each(samples)("$name, opened in the editor", ({ markdown }) => {
  test("saves byte for byte without edits", () => {
    const draft = openDraft(markdown);
    expect(markdownOf(draft, draft.state)).toBe(markdown);
  });
});

/** A draft with the text between the first `[` and `]` selected (the brackets taken out), as a User selects it. */
function open(marked: string): { draft: Draft; state: EditorState } {
  const draft = openDraft(marked.replace("[", "").replace("]", ""));
  let state = draft.state;
  const from = marked.indexOf("[");
  if (from >= 0) {
    const to = marked.indexOf("]") - 1;
    const pos = (offset: number) => {
      let found = 1;
      state.doc.descendants((node, nodePos) => {
        if (!node.isText) return true;
        const text = marked.replace("[", "").replace("]", "");
        const start = text.indexOf(node.text!);
        if (start <= offset && offset <= start + node.text!.length) found = nodePos + offset - start;
        return false;
      });
      return found;
    };
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos(from), pos(to))));
  }
  return { draft, state };
}

function run(state: EditorState, ...commands: Command[]): EditorState {
  for (const command of commands) {
    expect(command(state, (tr) => (state = state.apply(tr)))).toBe(true);
  }
  return state;
}

/** Types text as the browser hands it over, character by character, through the Markdown shortcuts. */
function type(state: EditorState, text: string): EditorState {
  const view = {
    composing: false,
    get state() {
      return state;
    },
    dispatch(tr: EditorState["tr"]) {
      state = state.apply(tr);
    },
  };
  for (const char of text) {
    const { from, to } = state.selection;
    const handled = state.plugins.some((plugin) =>
      (plugin.props.handleTextInput as ((...args: unknown[]) => boolean) | undefined)?.call(plugin, view, from, to, char, () => state.tr.insertText(char, from, to)),
    );
    if (!handled) state = state.apply(state.tr.insertText(char, from, to));
  }
  return state;
}

/** The cursor at the end of the document's last textblock. */
function atEnd(state: EditorState): EditorState {
  return state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));
}

describe("formatting", () => {
  test("bold on a selection changes only that block, and undo gives the Markdown back exactly", () => {
    const { draft, state } = open("Runs  start from a [Brief].\n\n*  kept   as written\n");
    const bold = run(state, toggleBold);
    expect(markdownOf(draft, bold)).toBe("Runs  start from a **Brief**.\n\n*  kept   as written\n");
    expect(markdownOf(draft, run(bold, undo))).toBe("Runs  start from a Brief.\n\n*  kept   as written\n");
  });

  test("italic, a heading, a quote and a link from the toolbar's commands", () => {
    const { draft, state } = open("[Title]\n\nBody.");
    expect(markdownOf(draft, run(state, toggleHeading(2)))).toBe("## Title\n\nBody.");
    expect(markdownOf(draft, run(state, toggleItalic))).toBe("*Title*\n\nBody.");
    expect(markdownOf(draft, run(state, toggleQuote))).toBe("> Title\n\nBody.");
    expect(markdownOf(draft, run(state, setLink("https://example.com")))).toBe("[Title](https://example.com)\n\nBody.");
  });

  test("a task list, ticked, and a plain list again", () => {
    const { draft, state } = open("[Buy milk]");
    const tasks = run(state, toggleTaskList);
    expect(markdownOf(draft, tasks)).toBe("- [ ] Buy milk");
    expect(markdownOf(draft, run(tasks, toggleTask))).toBe("- [x] Buy milk");
    expect(markdownOf(draft, run(tasks, toggleBulletList))).toBe("- Buy milk");
  });

  test("a table gets a row, and a rule goes after the block", () => {
    const { draft, state } = open("[Intro.]");
    const table = run(state, insertTable, addRowAfter);
    expect(markdownOf(draft, table)).toBe("Intro.\n\n|  |  |\n| --- | --- |\n|  |  |\n|  |  |");
    expect(markdownOf(draft, run(state, insertRule))).toBe("Intro.\n\n---");
  });
});

describe("Markdown shortcuts as one types", () => {
  test("headings, lists, tasks, quotes and marks", () => {
    const empty = openDraft("");
    const typed = (text: string) => markdownOf(empty, type(atEnd(empty.state), text));
    expect(typed("## Plan")).toBe("## Plan");
    expect(typed("- one")).toBe("- one");
    expect(typed("1. one")).toBe("1. one");
    expect(typed("- [ ] todo")).toBe("- [ ] todo");
    expect(typed("> said")).toBe("> said");
    expect(typed("a **b** *c* `d` ~~e~~")).toBe("a **b** *c* `d` ~~e~~");
    expect(typed("---")).toBe("---");
  });
});

describe("pasting and attaching", () => {
  test("plain text pasted is read as Markdown", () => {
    const { draft, state } = open("Before [here].");
    const slice = sliceFromText("**bold** and `code`", state.selection.$from);
    expect(markdownOf(draft, state.apply(state.tr.replaceSelection(slice)))).toBe("Before **bold** and `code`.");
  });

  test("an Attachment's reference goes in at the cursor and saves exactly", () => {
    const draft = openDraft("Before.\n\nAfter.");
    const at = draft.state.apply(draft.state.tr.setSelection(TextSelection.create(draft.state.doc, 8)));
    const reference = "![brief.png](attachment:0b6c8e1e-6f0a-4b8e-9f7c-6c3c1b9f2a10)";
    expect(markdownOf(draft, run(at, insertMarkdown(reference)))).toBe(`Before.${reference}\n\nAfter.`);
  });
});
