import { lazy, Suspense } from "react";
import type { RichEditorProps } from "./rich-editor.js";

const Loaded = lazy(() => import("./rich-editor.js").then((module) => ({ default: module.RichEditor })));

/**
 * The shared rich editor (`./rich-editor.tsx`), loaded the first time a screen shows one, so its ProseMirror and
 * Markdown parsers stay out of the main bundle. Until it is in, a box of its size holds its place.
 */
export function RichEditor(props: RichEditorProps) {
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
      <Loaded {...props} />
    </Suspense>
  );
}
