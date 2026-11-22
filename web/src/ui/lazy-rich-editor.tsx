import { lazy, Suspense, useCallback, useImperativeHandle, useRef } from "react";
import type { RichEditorHandle, RichEditorProps } from "./rich-editor.js";

const Loaded = lazy(() => import("./rich-editor.js").then((module) => ({ default: module.RichEditor })));

/**
 * The shared rich editor (`./rich-editor.tsx`), loaded the first time a screen shows one, so its ProseMirror and
 * Markdown parsers stay out of the main bundle. Until it is in, a box of its size holds its place, and a focus asked for
 * meanwhile, as by the Inbox's A, waits for the editor.
 */
export function RichEditor({ handle, ...props }: RichEditorProps) {
  const editor = useRef<RichEditorHandle | null>(null);
  const wantsFocus = useRef(false);
  useImperativeHandle(
    handle,
    () => ({
      textbox: () => editor.current?.textbox() ?? null,
      focus: () => {
        if (editor.current) editor.current.focus();
        else wantsFocus.current = true;
      },
    }),
    [],
  );
  const loaded = useCallback((handle: RichEditorHandle | null) => {
    editor.current = handle;
    if (handle && wantsFocus.current) {
      wantsFocus.current = false;
      handle.focus();
    }
  }, []);
  return (
    <Suspense
      fallback={
        <div className={`field rich-editor rich-editor-loading${props.compact ? " compact" : ""}`} aria-busy="true">
          {!props.hideLabel && <span className="field-label">{props.label ?? "Body"}</span>}
          <div className="rich-editor-frame">
            <p className="muted small">Loading the editor…</p>
          </div>
        </div>
      }
    >
      <Loaded {...props} handle={loaded} />
    </Suspense>
  );
}
