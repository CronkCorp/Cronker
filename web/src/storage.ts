/** Browser storage can be unavailable, such as in a private window; nothing here depends on it. */
export function safely<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

const returnAfterSignInKey = "cronk_return_after_sign_in";

/** Remembers a page to come back to once signed in, for a sign-in that leaves Cronk, such as with GitHub. */
export function returnAfterSignIn(path: string): void {
  safely(() => sessionStorage.setItem(returnAfterSignInKey, path));
}

/** The page to come back to after signing in, if one was remembered; it is forgotten once taken. */
export function takeReturnAfterSignIn(): string | undefined {
  const path = safely(() => sessionStorage.getItem(returnAfterSignInKey)) ?? undefined;
  if (path) safely(() => sessionStorage.removeItem(returnAfterSignInKey));
  return path;
}

/** The web client's theme: System follows the browser's `prefers-color-scheme`; Light and Dark override it. */
export type Theme = "system" | "light" | "dark";

/** Also read by the inline script in `index.html`, which applies the stored theme before first paint. */
const themeKey = "cronk_theme";

/** The theme chosen on this browser; System when none was, or storage can't be read. */
export function storedTheme(): Theme {
  const stored = safely(() => localStorage.getItem(themeKey));
  return stored === "light" || stored === "dark" ? stored : "system";
}

/** Applies a theme to the page and keeps it on this browser, not on the User, so each device can differ. */
export function chooseTheme(theme: Theme): void {
  if (theme === "system") {
    delete document.documentElement.dataset.theme;
    safely(() => localStorage.removeItem(themeKey));
  } else {
    document.documentElement.dataset.theme = theme;
    safely(() => localStorage.setItem(themeKey, theme));
  }
}

const sidebarHiddenKey = "cronk_sidebar_hidden";

/** Whether the sidebar was hidden on this browser; shown when it wasn't, or storage can't be read. */
export function storedSidebarHidden(): boolean {
  return safely(() => localStorage.getItem(sidebarHiddenKey)) === "true";
}

/** Keeps whether the sidebar is hidden on this browser, like the theme, so each device can differ. */
export function keepSidebarHidden(hidden: boolean): void {
  safely(() => (hidden ? localStorage.setItem(sidebarHiddenKey, "true") : localStorage.removeItem(sidebarHiddenKey)));
}

/** How the rich editor edits Markdown: as formatted text, or as its Markdown source. */
export type EditorMode = "rich" | "source";

const editorModeKey = "cronk_editor_mode";

/** The editor mode last chosen on this browser; formatted text when none was, or storage can't be read. */
export function storedEditorMode(): EditorMode {
  return safely(() => localStorage.getItem(editorModeKey)) === "source" ? "source" : "rich";
}

/** Keeps the editor mode on this browser, for every editor opened after. */
export function chooseEditorMode(mode: EditorMode): void {
  safely(() => (mode === "source" ? localStorage.setItem(editorModeKey, "source") : localStorage.removeItem(editorModeKey)));
}
