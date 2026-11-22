import { EditorView, type NodeView } from "prosemirror-view";
import type { Node } from "prosemirror-model";
import type { Command, EditorState } from "prosemirror-state";
import { useEffect, useId, useImperativeHandle, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { api, attachmentUrl, type AttachmentOwner } from "../api.js";
import { markdownReference } from "../attachments.js";
import { schema } from "../editor/schema.js";
import {
  addColumnAfter,
  addRowAfter,
  blockActive,
  deleteColumn,
  deleteRow,
  inAncestor,
  insertMarkdown,
  insertRule,
  insertTable,
  isAddress,
  isInTable,
  linkAt,
  listAround,
  markActive,
  markdownOf,
  openDraft,
  redo,
  setLink,
  setTaskAt,
  sliceFromText,
  textFromSlice,
  toggleBold,
  toggleBulletList,
  toggleCodeBlock,
  toggleHeading,
  toggleInlineCode,
  toggleItalic,
  toggleOrderedList,
  toggleQuote,
  toggleStrikethrough,
  toggleTaskList,
  undo,
  type Draft,
} from "../editor/state.js";
import { submitOnCtrlOrCmdEnter } from "../forms.js";
import { chooseEditorMode, storedEditorMode, type EditorMode } from "../storage.js";
import { Button, Field, FormError } from "./controls.js";
import { Dialog, DialogActions, DialogClose } from "./overlays.js";

const onMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** `attachment:<id>` as where the Attachment downloads from, for showing it; the node keeps the reference itself. */
function shownSource(src: string): string {
  const attachment = /^attachment:([0-9a-f-]{36})$/i.exec(src.trim());
  return attachment ? attachmentUrl(attachment[1]!) : src;
}

/** An image, an Attachment's shown from where it downloads. */
function imageView(node: Node): NodeView {
  const img = document.createElement("img");
  const show = (image: Node) => {
    img.src = shownSource(String(image.attrs.src));
    img.alt = String(image.attrs.alt ?? "");
    if (image.attrs.title) img.title = String(image.attrs.title);
    else img.removeAttribute("title");
  };
  show(node);
  return {
    dom: img,
    update(next) {
      if (next.type !== node.type) return false;
      show(next);
      return true;
    },
  };
}

/** A list item; a task item has a box to tick, which saves as `[x]`. */
function listItemView(node: Node, view: EditorView, getPos: () => number | undefined): NodeView {
  const li = document.createElement("li");
  if (node.attrs.checked === null) {
    return { dom: li, contentDOM: li, update: (next) => next.type === node.type && next.attrs.checked === null };
  }
  let current = node;
  li.className = "task-item";
  const holder = document.createElement("span");
  holder.className = "task-box";
  holder.contentEditable = "false";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.tabIndex = -1;
  box.checked = Boolean(node.attrs.checked);
  box.setAttribute("aria-label", "Done");
  box.addEventListener("mousedown", (event) => event.preventDefault());
  box.addEventListener("change", () => {
    const pos = getPos();
    if (pos !== undefined) setTaskAt(pos, box.checked)(view.state, view.dispatch);
  });
  holder.append(box);
  const content = document.createElement("div");
  content.className = "task-text";
  li.append(holder, content);
  return {
    dom: li,
    contentDOM: content,
    update(next) {
      if (next.type !== current.type || next.attrs.checked === null) return false;
      current = next;
      box.checked = Boolean(next.attrs.checked);
      return true;
    },
    stopEvent: (event) => holder.contains(event.target as globalThis.Node),
    ignoreMutation: (mutation) => holder.contains(mutation.target),
  };
}

interface Tool {
  label: string;
  glyph: ReactNode;
  className?: string;
  keys?: string;
  command: Command;
  active?: boolean;
}

/** A shortcut as this platform writes it, such as Ctrl+B or ⌘B. */
function shortcut(keys: string): string {
  return keys
    .split("-")
    .map((key) => (key === "Mod" ? (onMac ? "⌘" : "Ctrl") : key === "Alt" ? (onMac ? "⌥" : "Alt") : key.length === 1 ? key.toUpperCase() : key))
    .join(onMac ? "" : "+");
}

/** The same shortcut as `aria-keyshortcuts` names it. */
function ariaKeys(keys: string): string {
  return keys
    .split("-")
    .map((key) => (key === "Mod" ? (onMac ? "Meta" : "Control") : key.length === 1 ? key.toUpperCase() : key))
    .join("+");
}

/** The editor's toolbar: one tab stop, its buttons reached with the arrow keys, Home and End; Escape goes back to the text. */
function Toolbar({ state, view, onLink }: { state: EditorState; view: EditorView; onLink: () => void }) {
  const nodes = schema.nodes;
  const marks = schema.marks;
  const list = listAround(state);
  const inTable = isInTable(state);
  const groups: Tool[][] = [
    [1, 2, 3].map((level) => ({
      label: `Heading ${level}`,
      glyph: `H${level}`,
      keys: `Mod-Alt-${level}`,
      command: toggleHeading(level),
      active: blockActive(state, nodes.heading!, { level }),
    })),
    [
      { label: "Bold", glyph: "B", className: "tool-bold", keys: "Mod-b", command: toggleBold, active: markActive(state, marks.strong!) },
      { label: "Italic", glyph: "I", className: "tool-italic", keys: "Mod-i", command: toggleItalic, active: markActive(state, marks.em!) },
      {
        label: "Strikethrough",
        glyph: "S",
        className: "tool-strike",
        keys: "Mod-Shift-x",
        command: toggleStrikethrough,
        active: markActive(state, marks.strikethrough!),
      },
      { label: "Inline code", glyph: "</>", className: "tool-mono", keys: "Mod-e", command: toggleInlineCode, active: markActive(state, marks.code!) },
      {
        label: "Link",
        glyph: "Link",
        keys: "Mod-k",
        command: (_state, dispatch) => {
          if (dispatch) onLink();
          return true;
        },
        active: markActive(state, marks.link!),
      },
    ],
    [
      { label: "Bulleted list", glyph: "•", keys: "Mod-Shift-8", command: toggleBulletList, active: list !== null && list.type === nodes.bullet_list && !list.task },
      { label: "Numbered list", glyph: "1.", keys: "Mod-Shift-7", command: toggleOrderedList, active: list !== null && list.type === nodes.ordered_list && !list.task },
      { label: "Task list", glyph: "☐", keys: "Mod-Shift-9", command: toggleTaskList, active: !!list?.task },
      { label: "Quote", glyph: "“", keys: "Mod-Shift-b", command: toggleQuote, active: inAncestor(state, nodes.blockquote!) },
      { label: "Code block", glyph: "{ }", className: "tool-mono", keys: "Mod-Alt-c", command: toggleCodeBlock, active: blockActive(state, nodes.code_block!) },
      { label: "Table", glyph: "Table", command: insertTable },
      { label: "Horizontal rule", glyph: "―", command: insertRule },
    ],
    ...(inTable
      ? [
          [
            { label: "Add row", glyph: "+ Row", command: addRowAfter },
            { label: "Add column", glyph: "+ Column", command: addColumnAfter },
            { label: "Delete row", glyph: "− Row", command: deleteRow },
            { label: "Delete column", glyph: "− Column", command: deleteColumn },
          ],
        ]
      : []),
    [
      { label: "Undo", glyph: "↶", keys: "Mod-z", command: undo },
      { label: "Redo", glyph: "↷", keys: "Shift-Mod-z", command: redo },
    ],
  ];
  const tools = groups.flat();
  const [focused, setFocused] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const at = Math.min(focused, tools.length - 1);

  const move = (event: KeyboardEvent) => {
    const to =
      event.key === "ArrowRight" ? (at + 1) % tools.length
      : event.key === "ArrowLeft" ? (at - 1 + tools.length) % tools.length
      : event.key === "Home" ? 0
      : event.key === "End" ? tools.length - 1
      : null;
    if (event.key === "Escape") {
      event.preventDefault();
      view.focus();
      return;
    }
    if (to === null) return;
    event.preventDefault();
    setFocused(to);
    refs.current[to]?.focus();
  };

  let index = 0;
  return (
    <div role="toolbar" aria-label="Formatting" className="rich-editor-tools" onKeyDown={move}>
      {groups.map((group, g) => (
        <span key={g} className="rich-editor-group">
          {g > 0 && <span role="separator" aria-orientation="vertical" className="rich-editor-separator" />}
          {group.map((tool) => {
            const i = index++;
            const enabled = tool.command(state);
            return (
              <button
                key={tool.label}
                ref={(element) => {
                  refs.current[i] = element;
                }}
                type="button"
                className={`rich-editor-tool${tool.className ? ` ${tool.className}` : ""}`}
                tabIndex={i === at ? 0 : -1}
                aria-label={tool.label}
                title={tool.keys ? `${tool.label} (${shortcut(tool.keys)})` : tool.label}
                aria-keyshortcuts={tool.keys ? ariaKeys(tool.keys) : undefined}
                aria-pressed={tool.active === undefined ? undefined : tool.active}
                aria-disabled={enabled ? undefined : true}
                onFocus={() => setFocused(i)}
                // The text keeps its selection while a button is pressed.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (!enabled) return;
                  tool.command(view.state, view.dispatch, view);
                  if (tool.label !== "Link") view.focus();
                }}
              >
                <span aria-hidden="true">{tool.glyph}</span>
              </button>
            );
          })}
        </span>
      ))}
    </div>
  );
}

/** Asks for a link's address; an empty one removes the link. */
function LinkDialog({ view, onClose }: { view: EditorView; onClose: () => void }) {
  const [href, setHref] = useState(() => linkAt(view.state) ?? "");
  const existing = linkAt(view.state) !== null;
  const apply = (address: string) => {
    setLink(address)(view.state, view.dispatch);
    onClose();
    setTimeout(() => view.focus());
  };
  return (
    <Dialog open onOpenChange={(open) => !open && (onClose(), setTimeout(() => view.focus()))} title={existing ? "Edit link" : "Add link"}>
      <form
        onSubmit={(event: FormEvent) => {
          // The dialog's form sits inside the editor's in React's tree, so its submit stops here.
          event.preventDefault();
          event.stopPropagation();
          apply(href);
        }}
      >
        <Field label="Address">
          <input value={href} onChange={(e) => setHref(e.target.value)} placeholder="https://" autoFocus />
        </Field>
        <DialogActions>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          {existing && <Button onClick={() => apply("")}>Remove link</Button>}
          <Button type="submit" variant="primary">
            {existing ? "Save link" : "Add link"}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

/** What a screen can do with an editor it holds: reach its text, in whichever mode it is. */
export interface RichEditorHandle {
  /** The text being edited: the formatted text, or the Markdown source. */
  textbox(): HTMLElement | null;
}

export interface RichEditorProps {
  value: string;
  onChange: (markdown: string) => void;
  label?: string;
  /** The label is for screen readers only, as a Comment box's is. */
  hideLabel?: boolean;
  hint?: ReactNode;
  /** Shown in the empty text. */
  placeholder?: string;
  /** A short box, for a Comment, a Reply or an answer. */
  compact?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Ctrl+Enter, or Cmd+Enter, submits the form the editor is in, as a Comment box does. */
  submitOnCtrlOrCmdEnter?: boolean;
  /** Where files dropped or pasted in are attached, if anywhere. */
  attachTo?: AttachmentOwner;
  onAttached?: () => void;
  handle?: Ref<RichEditorHandle>;
}

/**
 * The shared rich editor: Markdown in, Markdown out. It edits formatted text, with a toolbar, the usual keys and
 * Markdown shortcuts as one types, or the Markdown source itself; the last mode is kept on this browser. Saving writes
 * the blocks no edit touched exactly as they were loaded (see `web/src/editor/round-trip.ts`), so opening and saving
 * gives back the same Markdown. Files pasted or dropped are attached to `attachTo` and referenced where they landed.
 */
export function RichEditor({
  value,
  onChange,
  label = "Body",
  hideLabel = false,
  hint,
  placeholder,
  compact = false,
  disabled = false,
  autoFocus = false,
  submitOnCtrlOrCmdEnter: submits = false,
  attachTo,
  onAttached,
  handle,
}: RichEditorProps) {
  const labelId = useId();
  const [mode, setMode] = useState<EditorMode>(storedEditorMode);
  const [state, setState] = useState<EditorState | null>(null);
  const [linking, setLinking] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const mount = useRef<HTMLDivElement>(null);
  const source = useRef<HTMLTextAreaElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const draftRef = useRef<Draft | null>(null);
  // The Markdown last given out, so a value coming back in isn't loaded again.
  const emitted = useRef(value);
  const latest = useRef({ value, onChange, attachTo, onAttached, submits, disabled, placeholder });
  latest.current = { value, onChange, attachTo, onAttached, submits, disabled, placeholder };

  useImperativeHandle(handle, () => ({ textbox: () => viewRef.current?.dom ?? source.current }), []);

  const hooks = { editLink: () => setLinking(true) };

  /** Attaches each file, then puts its reference where it was given: at a position in the text, or the cursor. */
  const attach = async (files: File[], pos?: number) => {
    const owner = latest.current.attachTo;
    if (!owner || files.length === 0) return;
    setAttachError(null);
    const at = source.current?.selectionStart;
    try {
      const references: string[] = [];
      for (const file of files) references.push(markdownReference(await api.attach(owner, file)));
      const markdown = references.join("\n");
      const view = viewRef.current;
      if (view) {
        insertMarkdown(markdown, pos === undefined ? undefined : Math.min(pos, view.state.doc.content.size))(view.state, view.dispatch);
      } else {
        const text = latest.current.value;
        const cursor = at ?? text.length;
        give(`${text.slice(0, cursor)}${markdown}${text.slice(cursor)}`);
      }
      latest.current.onAttached?.();
    } catch (e) {
      setAttachError(e instanceof Error ? e.message : String(e));
    }
  };

  const give = (markdown: string) => {
    emitted.current = markdown;
    latest.current.onChange(markdown);
  };

  const load = (view: EditorView, markdown: string) => {
    const draft = openDraft(markdown, hooks);
    draftRef.current = draft;
    view.updateState(draft.state);
    setState(draft.state);
  };

  useEffect(() => {
    if (mode !== "rich" || !mount.current) return;
    const draft = openDraft(latest.current.value, hooks);
    draftRef.current = draft;
    const view: EditorView = new EditorView(mount.current, {
      state: draft.state,
      editable: () => !latest.current.disabled,
      attributes: (state) => {
        const empty = state.doc.childCount === 1 && state.doc.firstChild!.isTextblock && state.doc.firstChild!.content.size === 0;
        const placeholder = latest.current.placeholder;
        return {
          class: "markdown rich-editor-text",
          role: "textbox",
          "aria-multiline": "true",
          "aria-labelledby": labelId,
          spellcheck: "true",
          ...(latest.current.disabled ? { "aria-disabled": "true" } : {}),
          ...(placeholder ? { "aria-placeholder": placeholder, ...(empty ? { "data-placeholder": placeholder } : {}) } : {}),
        };
      },
      nodeViews: { image: imageView, list_item: listItemView },
      clipboardTextParser: (text, $context) => sliceFromText(text, $context),
      clipboardTextSerializer: textFromSlice,
      handlePaste(view, event) {
        const data = event.clipboardData;
        if (!data) return false;
        const text = data.getData("text/plain");
        // A paste carrying text pastes the text and attaches nothing.
        if (data.files.length > 0 && !text) {
          if (!latest.current.attachTo) return false;
          void attach([...data.files]);
          return true;
        }
        if (!view.state.selection.empty && isAddress(text) && !view.state.selection.$from.parent.type.spec.code) {
          return setLink(text.trim())(view.state, view.dispatch);
        }
        return false;
      },
      handleDrop(view, event, _slice, moved) {
        const files = event.dataTransfer?.files;
        if (moved || !files || files.length === 0 || !latest.current.attachTo) return false;
        event.preventDefault();
        void attach([...files], view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos);
        return true;
      },
      handleKeyDown(view, event) {
        if (latest.current.submits && submitOnCtrlOrCmdEnter(event, view.dom)) return true;
        // Alt+F10 reaches the toolbar from the text, as in other editors.
        if (event.altKey && event.key === "F10") {
          event.preventDefault();
          toolbar.current?.querySelector<HTMLButtonElement>('button[tabindex="0"]')?.focus();
          return true;
        }
        return false;
      },
      dispatchTransaction(tr) {
        const next = view.state.apply(tr);
        view.updateState(next);
        setState(next);
        if (tr.docChanged && draftRef.current) give(markdownOf(draftRef.current, next));
      },
    });
    viewRef.current = view;
    setState(view.state);
    if (autoFocus) view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
      setState(null);
    };
  }, [mode]);

  // Disabled, as while what was written is being sent, the text can't be changed.
  useEffect(() => {
    viewRef.current?.setProps({ editable: () => !disabled });
  }, [disabled]);

  // Markdown changed from outside, such as a draft put back, is loaded afresh.
  useEffect(() => {
    if (value === emitted.current) return;
    emitted.current = value;
    if (viewRef.current) load(viewRef.current, value);
  }, [value]);

  const switchTo = (next: EditorMode) => {
    if (next === mode) return;
    chooseEditorMode(next);
    setMode(next);
  };

  const onSourceDrop = (event: DragEvent<HTMLTextAreaElement>) => {
    if (!attachTo || event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    void attach([...event.dataTransfer.files]);
  };
  const onSourcePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!attachTo || event.clipboardData.files.length === 0 || event.clipboardData.getData("text")) return;
    event.preventDefault();
    void attach([...event.clipboardData.files]);
  };

  return (
    <div className={`field rich-editor${compact ? " compact" : ""}`}>
      <span className={hideLabel ? "sr-only" : "field-label"} id={labelId}>
        {label}
      </span>
      <div className="rich-editor-frame">
        <div className="rich-editor-bar" ref={toolbar}>
          {mode === "rich" && state && viewRef.current ? (
            <Toolbar state={state} view={viewRef.current} onLink={() => setLinking(true)} />
          ) : (
            <span className="rich-editor-tools muted small">Markdown source</span>
          )}
          <div role="group" aria-label="Editing mode" className="segmented rich-editor-mode">
            <button type="button" className="segmented-item" aria-pressed={mode === "rich"} onClick={() => switchTo("rich")}>
              Rich text
            </button>
            <button type="button" className="segmented-item" aria-pressed={mode === "source"} onClick={() => switchTo("source")}>
              Markdown
            </button>
          </div>
        </div>
        {mode === "rich" ? (
          <div ref={mount} className="rich-editor-surface" />
        ) : (
          <textarea
            ref={source}
            className="markdown-source rich-editor-source"
            aria-label={`${label}, as Markdown`}
            value={value}
            rows={compact ? 4 : 20}
            placeholder={placeholder}
            disabled={disabled}
            autoFocus={autoFocus}
            onChange={(e) => give(e.target.value)}
            onKeyDown={(event) => {
              if (submits) submitOnCtrlOrCmdEnter(event.nativeEvent, event.currentTarget);
            }}
            onDrop={onSourceDrop}
            onPaste={onSourcePaste}
          />
        )}
      </div>
      {hint && <span className="field-hint">{hint}</span>}
      <FormError error={attachError} />
      {linking && viewRef.current && <LinkDialog view={viewRef.current} onClose={() => setLinking(false)} />}
    </div>
  );
}
