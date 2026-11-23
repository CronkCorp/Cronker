import { useEffect, useState, type RefObject } from "react";

/**
 * The text selected within the element, trimmed, with where it ends on screen for a button under it, such as Redact
 * or Comment; null while nothing there is selected.
 */
export function useSelectionIn(
  within: RefObject<HTMLElement | null>,
  /** A selector for parts of the element whose text doesn't count, such as what is placed in it. */
  ignore?: string,
): { text: string; bottom: number; left: number } | null {
  const [selected, setSelected] = useState<{ text: string; bottom: number; left: number } | null>(null);
  useEffect(() => {
    const read = () => {
      const current = window.getSelection();
      const element = within.current;
      if (!current || current.isCollapsed || current.rangeCount === 0 || !element) return setSelected(null);
      const range = current.getRangeAt(0);
      if (!element.contains(range.commonAncestorContainer)) return setSelected(null);
      const ignored = (node: Node) => ignore && (node instanceof Element ? node : node.parentElement)?.closest(ignore);
      if (ignored(range.startContainer) || ignored(range.endContainer)) return setSelected(null);
      const text = current.toString().trim();
      if (!text) return setSelected(null);
      const rect = range.getBoundingClientRect();
      setSelected({ text, bottom: rect.bottom, left: rect.left });
    };
    document.addEventListener("selectionchange", read);
    window.addEventListener("scroll", read, true);
    return () => {
      document.removeEventListener("selectionchange", read);
      window.removeEventListener("scroll", read, true);
    };
  }, [within, ignore]);
  return selected;
}
