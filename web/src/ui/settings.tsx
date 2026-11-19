import { useEffect, useState, type ReactNode } from "react";

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
  const [current, setCurrent] = useState<string | undefined>(sections[0]?.id);

  useEffect(() => {
    const elements = ids
      .split(" ")
      .map((id) => document.getElementById(id))
      .filter((element): element is HTMLElement => element !== null);
    // The section in view is the last one whose top has passed a third of the way down the window,
    // or the last section once the page is scrolled to its end.
    const update = () => {
      const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      const line = window.innerHeight / 3;
      const passed = elements.filter((element) => element.getBoundingClientRect().top <= line);
      const shown = atEnd ? elements[elements.length - 1] : (passed[passed.length - 1] ?? elements[0]);
      if (shown) setCurrent(shown.id);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [ids]);

  return (
    <div className="settings">
      <nav aria-label="Settings sections" className="settings-nav">
        {sections.map((section) => (
          <a key={section.id} href={`#${section.id}`} aria-current={section.id === current ? "true" : undefined}>
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
