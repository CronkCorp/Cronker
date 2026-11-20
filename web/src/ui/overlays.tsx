import * as RadixDialog from "@radix-ui/react-dialog";
import * as RadixMenu from "@radix-ui/react-dropdown-menu";
import * as RadixPopover from "@radix-ui/react-popover";
import { useState, type ReactNode } from "react";
import { navigate } from "../router.js";
import { Button, FormError } from "./controls.js";

/**
 * Radix UI's headless popover, dropdown menu and dialog, each wrapped once and styled by our classes. Screens use
 * these, never Radix directly.
 */

/** A popover opened by its trigger, such as a field picker's list. */
export function Popover({
  trigger,
  children,
  open,
  onOpenChange,
  label,
  align = "start",
}: {
  trigger: ReactNode;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  label?: string;
  align?: "start" | "end";
}) {
  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange}>
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content className="popover" align={align} sideOffset={4} aria-label={label} collisionPadding={8}>
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}

/** A menu of actions behind a button, such as "…" for destructive ones. */
export function Menu({
  label,
  trigger,
  children,
  align = "end",
}: {
  /** The accessible name of the default "…" trigger. */
  label: string;
  trigger?: ReactNode;
  children: ReactNode;
  align?: "start" | "end";
}) {
  return (
    <RadixMenu.Root modal={false}>
      <RadixMenu.Trigger asChild>
        {trigger ?? (
          <Button variant="secondary" aria-label={label} title={label}>
            …
          </Button>
        )}
      </RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content className="menu" align={align} sideOffset={4} collisionPadding={8}>
          {children}
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  );
}

/** An action in a Menu. */
export function MenuItem({
  children,
  onSelect,
  disabled,
  tone,
}: {
  children: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  tone?: "danger";
}) {
  return (
    <RadixMenu.Item className={`menu-item${tone ? ` menu-item-${tone}` : ""}`} disabled={disabled} onSelect={onSelect}>
      {children}
    </RadixMenu.Item>
  );
}

/** A page a Menu leads to. It navigates on Radix's select, which also closes the menu. */
export function MenuLink({ to, children, current }: { to: string; children: ReactNode; current?: boolean }) {
  return (
    <RadixMenu.Item className="menu-item" aria-current={current ? "page" : undefined} onSelect={() => navigate(to)}>
      {children}
    </RadixMenu.Item>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <RadixMenu.Label className="menu-label">{children}</RadixMenu.Label>;
}

/**
 * A segmented control inside a Menu, such as the theme's System / Light / Dark. Choosing keeps the menu open, so the
 * choice shows in place.
 */
export function MenuChoice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
}) {
  return (
    <RadixMenu.RadioGroup
      className="segmented menu-choice"
      aria-label={label}
      value={value}
      onValueChange={(next) => onChange(next as T)}
    >
      {options.map((option) => (
        <RadixMenu.RadioItem
          key={option.value}
          value={option.value}
          className="segmented-item"
          onSelect={(event) => event.preventDefault()}
        >
          {option.label}
        </RadixMenu.RadioItem>
      ))}
    </RadixMenu.RadioGroup>
  );
}

export function MenuSeparator() {
  return <RadixMenu.Separator className="menu-separator" />;
}

/** A dialog over the page; its action row is right-aligned, the dismissing button first. */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="dialog-overlay" />
        <RadixDialog.Content className={`dialog${wide ? " dialog-wide" : ""}`}>
          <RadixDialog.Title className="dialog-title">{title}</RadixDialog.Title>
          {description ? (
            <RadixDialog.Description className="dialog-description">{description}</RadixDialog.Description>
          ) : (
            <RadixDialog.Description className="sr-only">{title}</RadixDialog.Description>
          )}
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/** The right-aligned buttons of a dialog: Cancel first, the primary or danger button last. */
export function DialogActions({ children }: { children: ReactNode }) {
  return <div className="dialog-actions">{children}</div>;
}

export const DialogClose = RadixDialog.Close;

/** Asks before something that can't be undone; the only place a danger button appears. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  children,
  confirm,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  children?: ReactNode;
  /** The danger button's label, such as "Remove". */
  confirm: string;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setError(null);
        onOpenChange(next);
      }}
      title={title}
      description={children}
    >
      <FormError error={error} />
      <DialogActions>
        <DialogClose asChild>
          <Button variant="secondary">Cancel</Button>
        </DialogClose>
        <Button
          variant="danger"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onConfirm();
              onOpenChange(false);
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {confirm}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
