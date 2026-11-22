import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes } from "mdast";

/**
 * Rewriting GitHub's `#123` references in imported text to the Ticket keys the issues became, so they are Mentions
 * in Cronk at once. Only a bare `#123` is a reference: not `owner/repo#123`, `GH-123`, `&#123;` or an address's
 * fragment, and in Markdown never one in a code span, code block, raw HTML or link. A number with no Ticket stays as
 * written. Comments imported later go through the same function.
 */

const reference = /(?<![\w/&#\\-])#([1-9][0-9]{0,8})\b/g;

/** The issue numbers a text refers to, each once. */
export function referencedNumbers(text: string): number[] {
  return [...new Set([...text.matchAll(reference)].map((m) => Number(m[1])))];
}

/** Plain text, such as a title, with each `#123` that has a key rewritten to it. */
export function rewritePlain(text: string, keyOf: (number: number) => string | undefined): string {
  return text.replace(reference, (written, number: string) => keyOf(Number(number)) ?? written);
}

/** Markdown with each `#123` in its prose that has a key rewritten to it, the rest kept byte for byte. */
export function rewriteMarkdown(markdown: string, keyOf: (number: number) => string | undefined): string {
  if (!markdown.includes("#")) return markdown;
  const prose: [number, number][] = [];
  const walk = (node: Nodes) => {
    if (node.type === "text" && node.position?.start.offset !== undefined && node.position.end.offset !== undefined) {
      prose.push([node.position.start.offset, node.position.end.offset]);
    }
    if (node.type === "link" || node.type === "linkReference" || !("children" in node)) return;
    for (const child of node.children) walk(child);
  };
  walk(fromMarkdown(markdown));
  const inProse = (start: number, end: number) => prose.some(([from, to]) => from <= start && end <= to);
  return markdown.replace(reference, (written, number: string, offset: number) => {
    if (!inProse(offset, offset + written.length)) return written;
    return keyOf(Number(number)) ?? written;
  });
}
