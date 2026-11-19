import { useEffect, useRef, useState, type ReactNode } from "react";

export interface SettingsSection {
  /** The section's anchor, so a link to `#id` opens the page at it. */
  id: string;
  /** Its name in the section list. */
  label: string;
  /** Its panels. */
  children: ReactNode;
}

/**
 * Every settings page's layout: the list of its sections beside the sections themselves. A link in the
 * list brings its section into view, and the list marks the section in view. Below 760px the list wraps above them.
 */
export function SettingsLayout({ sections }: { sections: SettingsSection[] }) {
  const ids = sections.map((section) => section.id).join(" ");
  const [current, setCurrent] = useState<string | undefined>(() => {
    const hash = window.location.hash.slice(1);
    return sections.some((section) => section.id === hash) ? hash : sections[0]?.id;
  });

  // The section last clicked in the list, marked while it stays in view even where the page can't scroll its top up.
  const clicked = useRef<string | null>(null);

  useEffect(() => {
    const elements = ids
      .split(" ")
      .map((id) => document.getElementById(id))
      .filter((element): element is HTMLElement => element !== null);
    // As the page scrolls, the section in view is the last one whose top has passed a third of the way
    // down the window, or the last section once the page is scrolled to its end.
    const update = () => {
      const target = clicked.current ? document.getElementById(clicked.current) : null;
      const top = target?.getBoundingClientRect().top;
      if (target && top !== undefined && top >= 0 && top < window.innerHeight) {
        setCurrent(target.id);
        return;
      }
      clicked.current = null;
      const scrolled = window.scrollY > 0;
      const atEnd = scrolled && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      const line = window.innerHeight / 3;
      const passed = elements.filter((element) => element.getBoundingClientRect().top <= line);
      const shown = atEnd ? elements[elements.length - 1] : (passed[passed.length - 1] ?? elements[0]);
      if (shown) setCurrent(shown.id);
    };
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, [ids]);

  // A section dropped from the list, such as one emptied, marks the first instead.
  const marked = sections.some((section) => section.id === current) ? current : sections[0]?.id;

  return (
    <div className="settings">
      <nav aria-label="Settings sections" className="settings-nav">
        {sections.map((section) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            aria-current={section.id === marked ? "true" : undefined}
            onClick={() => {
              clicked.current = section.id;
              setCurrent(section.id);
            }}
          >
            {section.label}
          </a>
        ))}
      </nav>
      <div className="settings-sections">
        {sections.map((section) => (
          <div key={section.id} id={section.id} className="settings-section">
            {section.children}
          </div>
        ))}
      </div>
    </div>
  );
}
