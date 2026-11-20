import { useState, type FormEvent, type KeyboardEvent } from "react";

/** Runs a form's action, tracking whether it is busy and the error it ended with. */
export function useSubmit(action: (form: FormData, element: HTMLFormElement) => Promise<void>) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const element = event.currentTarget;
    setBusy(true);
    setError(null);
    try {
      await action(new FormData(element), element);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, onSubmit };
}

export const field = (form: FormData, name: string) => String(form.get(name) ?? "");

/**
 * A Comment box's keydown: Ctrl+Enter or Cmd+Enter submits its form as the submit button does, so an empty box
 * places nothing; plain Enter and Shift+Enter keep adding new lines.
 */
export function submitOnModEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
  event.preventDefault();
  event.currentTarget.form?.requestSubmit();
}

/**
 * Runs a settings page's saves one at a time, tracking whether one is busy, the error it ended with,
 * and whether the last one saved, for "Saved." beside the buttons.
 */
export function useSave() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const save = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await action();
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  /** Forgets the last save's error and "Saved.", as when its draft is thrown away. */
  const clear = () => {
    setError(null);
    setSaved(false);
  };
  return { error, busy, saved, save, clear };
}
