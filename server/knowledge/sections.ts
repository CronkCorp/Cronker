import type { Heading, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toString } from "mdast-util-to-string";
import { ApiError } from "../http/errors.js";

/**
 * Sections of a Document's Markdown: a heading of any level with everything under it up to the next heading of the
 * same or a higher level, its own subsections included. Only the Document's own headings count, not lines that look
 * like one inside a code block, a quote or a list.
 */

export interface Section {
  /** 1 for `#`, up to 6. */
  level: number;
  /** The heading as plain text, without its markers or inline formatting. */
  text: string;
  /** The texts of the headings it sits under, outermost first, ending with its own. */
  path: string[];
  /** Where its heading's line starts in the body. */
  start: number;
  /** Where the next heading of the same or a higher level starts, or the end of the body. */
  end: number;
}

/** The path of a Section as it is written: its headings' texts joined by `/`. */
export const pathOf = (section: Section) => section.path.join("/");

/** Where the line holding `offset` starts. */
function lineStart(markdown: string, offset: number): number {
  return markdown.lastIndexOf("\n", offset - 1) + 1;
}

function headingsOf(markdown: string): { level: number; text: string; start: number }[] {
  const tree: Root = fromMarkdown(markdown);
  return tree.children
    .filter((node): node is Heading => node.type === "heading")
    .map((heading) => ({
      level: heading.depth,
      text: toString(heading).trim(),
      start: lineStart(markdown, heading.position!.start.offset!),
    }));
}

/** Each Section of the Markdown, in the order their headings appear. */
export function sectionsOf(markdown: string): Section[] {
  const headings = headingsOf(markdown);
  const sections: Section[] = [];
  const above: Section[] = [];
  for (const [index, heading] of headings.entries()) {
    while (above.length > 0 && above.at(-1)!.level >= heading.level) above.pop();
    const next = headings.slice(index + 1).find((later) => later.level <= heading.level);
    const section: Section = {
      ...heading,
      path: [...above.map((outer) => outer.text), heading.text],
      end: next?.start ?? markdown.length,
    };
    sections.push(section);
    above.push(section);
  }
  return sections;
}

/** The segments of a name, each trimmed: `Install / Linux` is `Install`, `Linux`. */
const segmentsOf = (name: string) => name.split("/").map((segment) => segment.trim());

/**
 * The Sections a name matches: those whose heading reads as the whole name, and those whose path ends with the name's
 * segments when it joins headings with `/`, such as `Install/Linux` for `Linux` directly under `Install`. Texts are
 * compared exactly, after trimming.
 */
export function matchingSections(sections: Section[], name: string): Section[] {
  const whole = name.trim();
  const segments = segmentsOf(name);
  return sections.filter((section) => {
    if (section.text === whole) return true;
    if (segments.length < 2 || segments.length > section.path.length) return false;
    const tail = section.path.slice(-segments.length);
    return segments.every((segment, index) => tail[index] === segment);
  });
}

/** The one Section the name matches; refused, naming the candidates or the headings, unless exactly one does. */
export function findSection(markdown: string, name: string): Section {
  const sections = sectionsOf(markdown);
  const matches = matchingSections(sections, name);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    const candidates = matches.map(pathOf);
    throw new ApiError(
      409,
      "section_ambiguous",
      `"${name}" matches ${matches.length} Sections: ${candidates.join(", ")}.`,
      {
        rule: "A Section is named so that exactly one heading matches, so a replace never changes the wrong one.",
        advice: "Name the Section by one of the paths given as `candidates`.",
      },
      { candidates },
    );
  }
  const headings = sections.map(pathOf);
  throw new ApiError(
    404,
    "section_not_found",
    headings.length === 0
      ? `"${name}" matches no Section: the Document has no headings.`
      : `"${name}" matches no Section. The Document's headings are: ${headings.join(", ")}.`,
    {
      rule: "A Section is named by its heading's text, or by a path joining headings with `/`, such as `Install/Linux`.",
      advice: "Name one of the Document's headings, given as `headings`, or read the whole Document.",
    },
    { headings },
  );
}

/** The Section's Markdown, its heading included, without the blank lines that part it from what follows. */
export function sectionText(markdown: string, section: Section): string {
  return markdown.slice(section.start, section.end).replace(/\s+$/, "");
}

/**
 * The Markdown with the Section replaced by `replacement`, keeping the blank lines that part it from what follows.
 * The replacement must start with a heading of the Section's own level, and hold no other heading of that level or
 * a higher one, so it stays one Section; its heading's text may change.
 */
export function replaceSection(markdown: string, section: Section, replacement: string): string {
  const headings = headingsOf(replacement);
  const first = headings[0];
  const marks = "#".repeat(section.level);
  if (!first || first.level !== section.level || replacement.slice(0, first.start).trim() !== "") {
    throw new ApiError(
      400,
      "section_heading_level",
      `The new body must start with the Section's own heading, of level ${section.level} (\`${marks}\`).`,
      {
        rule: "A replace keeps the Section's own heading level, so the Document's outline stays as it was.",
        advice: `Start the new body with a level ${section.level} heading, such as \`${marks} ${section.text}\`, then its content.`,
      },
    );
  }
  const another = headings.slice(1).find((heading) => heading.level <= section.level);
  if (another) {
    throw new ApiError(
      400,
      "section_heading_level",
      `The new body holds another heading of level ${another.level}, "${another.text}", which would start another Section.`,
      {
        rule: "A replace changes one Section: headings under its own are of a lower level.",
        advice: `Make "${another.text}" a heading of level ${section.level + 1} or lower, or replace that Section on its own.`,
      },
    );
  }
  const original = markdown.slice(section.start, section.end);
  const parting = original.slice(original.replace(/\s+$/, "").length);
  const kept = replacement.slice(first.start).replace(/\s+$/, "");
  return markdown.slice(0, section.start) + kept + parting + markdown.slice(section.end);
}
