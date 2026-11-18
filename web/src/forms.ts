import { useState, type FormEvent } from "react";

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
