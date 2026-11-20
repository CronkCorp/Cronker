import { useEffect, useState, type ComponentProps, type MouseEvent } from "react";

/** A minimal client-side router over the History API. The server serves the web client for any page path. */

const listeners = new Set<() => void>();

export function navigate(path: string): void {
  if (path === window.location.pathname + window.location.search) return;
  window.history.pushState(null, "", path);
  for (const listener of listeners) listener();
}

/** Moves to a path without adding a history entry, such as away from a one-time link that has been used. */
export function replace(path: string): void {
  window.history.replaceState(null, "", path);
  for (const listener of listeners) listener();
}

export function usePath(): string {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    listeners.add(update);
    window.addEventListener("popstate", update);
    return () => {
      listeners.delete(update);
      window.removeEventListener("popstate", update);
    };
  }, []);
  return path;
}

/** The address's query, such as a search's `q`, kept current as it changes. */
export function useQuery(): URLSearchParams {
  const [search, setSearch] = useState(window.location.search);
  useEffect(() => {
    const update = () => setSearch(window.location.search);
    listeners.add(update);
    window.addEventListener("popstate", update);
    return () => {
      listeners.delete(update);
      window.removeEventListener("popstate", update);
    };
  }, []);
  return new URLSearchParams(search);
}

export function Link({
  to,
  current,
  ...props
}: { to: string; current?: boolean } & Omit<ComponentProps<"a">, "href" | "onClick">) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
  };
  return (
    <a {...props} href={to} onClick={onClick} aria-current={current ? "page" : undefined} />
  );
}
