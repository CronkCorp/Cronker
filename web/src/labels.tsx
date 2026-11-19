import type { ReactNode } from "react";

/** A Ticket or Project key, such as CRONK-12, in the mono face (docs/ui.md). */
export function Key({ children }: { children: ReactNode }) {
  return <span className="key">{children}</span>;
}

/** A Step's or trigger's model label, such as opus, in the mono face. */
export function ModelLabel({ children }: { children: ReactNode }) {
  return <span className="mono">{children}</span>;
}
