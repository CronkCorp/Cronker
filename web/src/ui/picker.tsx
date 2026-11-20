import { useId, useState, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { Popover } from "./overlays.js";

export interface PickerOption {
  value: string;
  /** What filtering matches, and the option's accessible name. */
  label: string;
  /** How the option shows, when not just its label. */
  content?: ReactNode;
  /** The heading the option is listed under, such as "This Project". */
  group?: string;
}

type Shown = PickerOption & { create?: boolean };

interface PickerProps {
  /** Names the list and its filter. */
  label: string;
  /** The button that opens the list. */
  trigger: ReactElement;
  options: PickerOption[];
  /** The values currently chosen, marked in the list. */
  selected?: string[];
  onPick: (value: string) => void;
  /** Takes typed text as a new value. */
  onCreate?: (text: string) => void;
  /** Picking toggles and keeps the list open. */
  multiple?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Shown in place of the list of options, such as while they load or when they can't be had. */
  notice?: ReactNode;
  /** Shown under the list, such as an action that loads its options again. */
  footer?: ReactNode;
}

/**
 * A popover list opened by its trigger, with type-to-filter. Once something is typed, Enter picks the first match;
 * a picker that takes new values (Labels) offers the typed text too.
 */
export function Picker({
  label,
  trigger,
  options,
  selected = [],
  onPick,
  onCreate,
  multiple = false,
  onOpenChange,
  notice,
  footer,
}: PickerProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);

  const typed = query.trim();
  const matches = typed ? options.filter((o) => o.label.toLowerCase().includes(typed.toLowerCase())) : options;
  const offerNew = onCreate && typed && !options.some((o) => o.label.toLowerCase() === typed.toLowerCase());
  const shown: Shown[] = [...matches, ...(offerNew ? [{ value: typed, label: `Add “${typed}”`, create: true }] : [])];

  const choose = (option: Shown) => {
    if (option.create) onCreate?.(option.value);
    else onPick(option.value);
    setQuery("");
    setActive(-1);
    if (!multiple) {
      setOpen(false);
      onOpenChange?.(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((at) => (shown.length === 0 ? -1 : (at + step + shown.length) % shown.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (notice !== undefined) return;
      const option = active >= 0 ? shown[active] : typed ? shown[0] : undefined;
      if (option) choose(option);
    }
  };

  const optionItem = (option: Shown, index: number) => {
    const isSelected = selected.includes(option.value) && !option.create;
    return (
      <li
        key={`${option.create ? "new:" : ""}${option.value}`}
        id={`${id}-option-${index}`}
        role="option"
        aria-selected={isSelected}
        aria-label={option.label}
        className={`picker-option${index === active ? " active" : ""}`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => choose(option)}
        onMouseEnter={() => setActive(index)}
      >
        <span className="picker-check" aria-hidden="true">
          {isSelected ? "✓" : ""}
        </span>
        {option.create ? option.label : (option.content ?? option.label)}
      </li>
    );
  };

  // Options keep their order; those of one group are listed together under its heading.
  const items: ReactNode[] = [];
  for (let index = 0; index < shown.length; ) {
    const group = shown[index]!.group;
    if (group === undefined) {
      items.push(optionItem(shown[index]!, index));
      index += 1;
      continue;
    }
    const start = index;
    while (index < shown.length && shown[index]!.group === group) index += 1;
    items.push(
      <li key={`group:${start}`} role="presentation" className="picker-group">
        <span className="picker-group-label" id={`${id}-group-${start}`} aria-hidden="true">
          {group}
        </span>
        <ul role="group" aria-labelledby={`${id}-group-${start}`}>
          {shown.slice(start, index).map((option, at) => optionItem(option, start + at))}
        </ul>
      </li>,
    );
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setQuery("");
        setActive(-1);
        onOpenChange?.(next);
      }}
      label={label}
      trigger={trigger}
    >
      <div className="picker">
        <input
          className="picker-filter"
          role="combobox"
          aria-label={`Filter ${label}`}
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-activedescendant={active >= 0 ? `${id}-option-${active}` : undefined}
          placeholder={onCreate ? "Filter, or type a new one…" : "Filter…"}
          value={query}
          autoFocus
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(-1);
          }}
          onKeyDown={onKeyDown}
        />
        {notice !== undefined ? (
          <div id={`${id}-list`} className="picker-empty">
            {notice}
          </div>
        ) : (
          <ul role="listbox" id={`${id}-list`} aria-label={label} aria-multiselectable={multiple || undefined} className="picker-list">
            {shown.length === 0 && <li className="picker-empty">{options.length === 0 ? "Nothing to pick." : "Nothing matches."}</li>}
            {items}
          </ul>
        )}
        {footer !== undefined && <div className="picker-footer">{footer}</div>}
      </div>
    </Popover>
  );
}

/** A Ticket field edited in place: its label, and its value, which opens a `Picker` when clicked. */
export function FieldPicker({
  value,
  disabled = false,
  title,
  before,
  ...picker
}: Omit<PickerProps, "trigger" | "onOpenChange"> & {
  /** The current value as shown on the field. */
  value: ReactNode;
  disabled?: boolean;
  /** Why the field can't be changed, when disabled. */
  title?: string;
  /** Shown before the value, outside the button, such as a link to what is picked. */
  before?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="field-row">
      <span className="field-row-label" id={`${id}-label`}>
        {picker.label}
      </span>
      <span className="field-row-value">
        {before}
        <Picker
          {...picker}
          trigger={
            <button
              type="button"
              className="picker-trigger"
              aria-labelledby={`${id}-label ${id}-value`}
              aria-haspopup="listbox"
              disabled={disabled}
              title={title}
            >
              <span id={`${id}-value`} className="picker-value">
                {value}
              </span>
            </button>
          }
        />
      </span>
    </div>
  );
}
