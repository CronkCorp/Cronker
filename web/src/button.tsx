import type { ComponentProps } from "react";

/**
 * The button variants of docs/ui.md: primary (one per form or action bar), secondary, ghost
 * (Reply, Rename and the like) and danger (only inside a confirming dialog).
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

/** The classes that make an element look like a button, for a link or a file picker. */
export function buttonClass(variant: ButtonVariant = "secondary"): string {
  return `button ${variant}`;
}

export function Button({
  variant = "secondary",
  className,
  ...props
}: { variant?: ButtonVariant } & ComponentProps<"button">) {
  return <button {...props} className={className ? `${buttonClass(variant)} ${className}` : buttonClass(variant)} />;
}
