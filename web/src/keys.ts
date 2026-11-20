/**
 * Whether a key press belongs to something else than a page-wide shortcut: it was typed into a field, or a dialog
 * is open.
 */
export function keyBelongsElsewhere(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  return (
    !!target?.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])") ||
    !!document.querySelector("[role=dialog]")
  );
}
