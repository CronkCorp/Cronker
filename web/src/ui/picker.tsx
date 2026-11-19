import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { Popover } from "./overlays.js";

export interface PickerOption {
  value: string;
  /** What filtering matches, and the option's accessible name. */
  label: string;
  /** How the option shows, when not just its label. */
  content?: ReactNode;
}

/**
 * A Ticket field edited in place: clicking its value opens a list with type-to-filter. Once something is typed,
 * Enter picks the first match; a picker that takes new values (Labels) offers the typed text too.
 */
export function FieldPicker({
  label,
  value,
  options,
  selected,
  onPick,
  onCreate,
  multiple = false,
  disabled = false,
  title,
  before,
}: {
  label: string;
  /** The current value as shown on the field. */
  value: ReactNode;
  options: PickerOption[];
  /** The values currently chosen, marked in the list. */
  selected: string[];
  onPick: (value: string) => void;
  /** Takes typed text as a new value. */
  onCreate?: (text: string) => void;
  /** Picking toggles and keeps the list open. */
  multiple?: boolean;
  disabled?: boolean;
  /** Why the field can't be changed, when disabled. */
  title?: string;
  /** Shown before the value, outside the button, such as a link to what is picked. */
  before?: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);

  const typed = query.trim();
  const matches = typed ? options.filter((o) => o.label.toLowerCase().includes(typed.toLowerCase())) : options;
  const offerNew = onCreate && typed && !options.some((o) => o.label.toLowerCase() === typed.toLowerCase());
  const shown: (PickerOption & { create?: boolean })[] = [
    ...matches,
    ...(offerNew ? [{ value: typed, label: `Add “${typed}”`, create: true }] : []),
  ];

  const choose = (option: PickerOption & { create?: boolean }) => {
    if (option.create) onCreate?.(option.value);
    else onPick(option.value);
    setQuery("");
    setActive(-1);
    if (!multiple) setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((at) => (shown.length === 0 ? -1 : (at + step + shown.length) % shown.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = active >= 0 ? shown[active] : typed ? shown[0] : undefined;
      if (option) choose(option);
    }
  };

  return (
    <div className="field-row">
      <span className="field-row-label" id={`${id}-label`}>
        {label}
      </span>
      <span className="field-row-value">
      {before}
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          setQuery("");
          setActive(-1);
        }}
        label={label}
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
          <ul role="listbox" id={`${id}-list`} aria-label={label} aria-multiselectable={multiple || undefined} className="picker-list">
            {shown.length === 0 && <li className="picker-empty">Nothing matches.</li>}
            {shown.map((option, index) => (
              <li
                key={`${option.create ? "new:" : ""}${option.value}`}
                id={`${id}-option-${index}`}
                role="option"
                aria-selected={selected.includes(option.value) && !option.create}
                aria-label={option.label}
                className={`picker-option${index === active ? " active" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(option)}
                onMouseEnter={() => setActive(index)}
              >
                <span className="picker-check" aria-hidden="true">
                  {selected.includes(option.value) && !option.create ? "✓" : ""}
                </span>
                {option.create ? option.label : (option.content ?? option.label)}
              </li>
            ))}
          </ul>
        </div>
      </Popover>
      </span>
    </div>
  );
}
