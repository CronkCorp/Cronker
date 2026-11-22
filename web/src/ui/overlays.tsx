import * as RadixContextMenu from "@radix-ui/react-context-menu";
import * as RadixDialog from "@radix-ui/react-dialog";
import * as RadixMenu from "@radix-ui/react-dropdown-menu";
import * as RadixPopover from "@radix-ui/react-popover";
import { createContext, useContext, useRef, useState, type ComponentProps, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { navigate } from "../router.js";
import { Button, FormError } from "./controls.js";

/**
 * Radix UI's headless popover, dropdown menu, context menu and dialog, each wrapped once and styled by our classes. Screens use
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

/**
 * A popover that shows what its button stands for, such as the Tickets a Blocked chip counts. Hovering or focusing
 * the button opens it without taking focus, and it closes once the pointer leaves both or focus moves on; clicking
 * the button opens it with focus inside, so its links can be reached from the keyboard, and Escape gives focus back.
 */
export function HoverPopover({
  label,
  button,
  children,
}: {
  /** The popover's accessible name. */
  label: string;
  /** The button's own attributes and content. */
  button: Omit<ComponentProps<"button">, "type" | "onClick" | "onFocus" | "onPointerEnter" | "onPointerLeave">;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // Whether focus went into the popover, so closing gives it back to the button.
  const [focusInside, setFocusInside] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const closing = useRef<number | undefined>(undefined);
  // Focus given back to the button on closing doesn't open the popover again.
  const givingFocusBack = useRef(false);
  const show = () => {
    window.clearTimeout(closing.current);
    if (!open) setFocusInside(false);
    setOpen(true);
  };
  const hideSoon = () => {
    window.clearTimeout(closing.current);
    if (!focusInside) closing.current = window.setTimeout(() => setOpen(false), 150);
  };
  const onTrigger = (target: EventTarget | null) => target instanceof Node && !!trigger.current?.contains(target);
  return (
    <RadixPopover.Root open={open} onOpenChange={setOpen}>
      <RadixPopover.Anchor asChild>
        <button
          {...button}
          ref={trigger}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          onPointerEnter={show}
          onPointerLeave={hideSoon}
          onFocus={() => {
            if (!givingFocusBack.current) show();
          }}
          onClick={() => {
            show();
            requestAnimationFrame(() => content.current?.querySelector<HTMLElement>("a[href], button")?.focus());
          }}
        />
      </RadixPopover.Anchor>
      <RadixPopover.Portal>
        <RadixPopover.Content
          ref={content}
          className="popover hover-popover"
          align="start"
          sideOffset={4}
          aria-label={label}
          collisionPadding={8}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!focusInside) return;
            givingFocusBack.current = true;
            trigger.current?.focus();
            givingFocusBack.current = false;
          }}
          // The button is outside the popover, but pressing or focusing it keeps the popover open.
          onInteractOutside={(event) => {
            if (onTrigger(event.target)) event.preventDefault();
          }}
          onFocus={() => setFocusInside(true)}
          onPointerEnter={() => window.clearTimeout(closing.current)}
          onPointerLeave={hideSoon}
        >
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}

/** The parts of a Radix menu the MenuItem family is drawn with, which differ between a Menu and a ContextMenu. */
type MenuParts = Pick<
  typeof RadixMenu,
  "Item" | "Label" | "Separator" | "RadioGroup" | "RadioItem" | "CheckboxItem" | "ItemIndicator" | "Sub" | "SubTrigger" | "SubContent" | "Portal"
>;
const contextMenuParts: MenuParts = RadixContextMenu;
/** Which menu the MenuItem family is inside: a Menu's dropdown unless a ContextMenu says otherwise. */
const MenuPartsContext = createContext<MenuParts>(RadixMenu);

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

/**
 * A menu of actions on a thing, such as a board card, opened by right-clicking it, by long-pressing it on a touch
 * screen, or from the keyboard with the ContextMenu key or Shift+F10 while it or something in it has focus. Escape
 * closes it and gives focus back. Its items are the MenuItem family's, as in a Menu.
 */
export function ContextMenu({
  label,
  content,
  children,
}: {
  /** The menu's accessible name, such as the Ticket's key and title. */
  label: string;
  /** The menu's items. */
  content: ReactNode;
  /** The thing it is on: one element, which takes its handlers. */
  children: ReactElement;
}) {
  return (
    <RadixContextMenu.Root modal={false}>
      <RadixContextMenu.Trigger asChild onKeyDown={openFromKeyboard}>
        {children}
      </RadixContextMenu.Trigger>
      <RadixContextMenu.Portal>
        <RadixContextMenu.Content
          className="menu"
          aria-label={label}
          collisionPadding={8}
          // Some browsers send their own contextmenu on the keyup of the key that opened this one, once focus is in it.
          onContextMenu={(event) => event.preventDefault()}
        >
          <MenuPartsContext.Provider value={contextMenuParts}>{content}</MenuPartsContext.Provider>
        </RadixContextMenu.Content>
      </RadixContextMenu.Portal>
    </RadixContextMenu.Root>
  );
}

/**
 * Opens a ContextMenu from the keyboard, under what has focus. Not every browser turns the ContextMenu key or
 * Shift+F10 into a contextmenu event, so it is sent here, once, in place of the browser's.
 */
function openFromKeyboard(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
  event.preventDefault();
  const focused = event.target instanceof HTMLElement ? event.target : event.currentTarget;
  const { left, bottom } = focused.getBoundingClientRect();
  focused.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: left, clientY: bottom }));
}

/** An action in a Menu or ContextMenu. */
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
  const { Item } = useContext(MenuPartsContext);
  return (
    <Item className={`menu-item${tone ? ` menu-item-${tone}` : ""}`} disabled={disabled} onSelect={onSelect}>
      {children}
    </Item>
  );
}

/** A page a Menu leads to. It navigates on Radix's select, which also closes the menu. */
export function MenuLink({ to, children, current }: { to: string; children: ReactNode; current?: boolean }) {
  const { Item } = useContext(MenuPartsContext);
  return (
    <Item className="menu-item" aria-current={current ? "page" : undefined} onSelect={() => navigate(to)}>
      {children}
    </Item>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  const { Label } = useContext(MenuPartsContext);
  return <Label className="menu-label">{children}</Label>;
}

/** A menu inside a Menu or ContextMenu behind one of its items, such as Move to; ArrowRight opens it, ArrowLeft goes back. */
export function MenuSub({ label, children }: { label: string; children: ReactNode }) {
  const { Sub, SubTrigger, SubContent, Portal } = useContext(MenuPartsContext);
  return (
    <Sub>
      <SubTrigger className="menu-item menu-sub-trigger">
        {label}
        <span className="menu-sub-arrow" aria-hidden="true">
          ›
        </span>
      </SubTrigger>
      <Portal>
        <SubContent className="menu" sideOffset={2} collisionPadding={8}>
          {children}
        </SubContent>
      </Portal>
    </Sub>
  );
}

/** The tick on a checked item; its checked state is announced by the item itself. */
function MenuCheck() {
  const { ItemIndicator } = useContext(MenuPartsContext);
  return (
    <span className="menu-check" aria-hidden="true">
      <ItemIndicator asChild>
        <svg className="menu-check-mark" viewBox="0 0 12 12">
          <path d="M2.5 6.5 5 9l4.5-6" />
        </svg>
      </ItemIndicator>
    </span>
  );
}

/** Items of which one is the current value, each announced as checked or not, such as a Ticket's Statuses. */
export function MenuRadioGroup<T extends string>({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: T;
  /** Called with the item chosen, which also closes the menu. */
  onChange: (value: T) => void;
  children: ReactNode;
}) {
  const { RadioGroup } = useContext(MenuPartsContext);
  return (
    <RadioGroup aria-label={label} value={value} onValueChange={(next) => onChange(next as T)}>
      {children}
    </RadioGroup>
  );
}

export function MenuRadioItem({ value, children }: { value: string; children: ReactNode }) {
  const { RadioItem } = useContext(MenuPartsContext);
  return (
    <RadioItem className="menu-item" value={value}>
      <MenuCheck />
      {children}
    </RadioItem>
  );
}

/** An on/off setting in a menu, announced as checked or not; choosing it flips it and closes the menu. */
export function MenuCheckboxItem({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  const { CheckboxItem } = useContext(MenuPartsContext);
  return (
    <CheckboxItem className="menu-item" checked={checked} onCheckedChange={(next) => onChange(next === true)}>
      <MenuCheck />
      {children}
    </CheckboxItem>
  );
}

export function MenuSeparator() {
  const { Separator } = useContext(MenuPartsContext);
  return <Separator className="menu-separator" />;
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
