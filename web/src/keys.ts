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

/**
 * Whether a page's single-key shortcut, such as the Inbox's J or the Ticket's C, should leave a key press alone: a
 * modifier is held (Ctrl, Cmd or Alt chords belong to the browser), or it belongs elsewhere.
 */
export const shortcutStandsAside = (event: KeyboardEvent): boolean =>
  event.metaKey || event.ctrlKey || event.altKey || keyBelongsElsewhere(event);
