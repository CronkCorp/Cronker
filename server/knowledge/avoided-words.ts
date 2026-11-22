import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { Type, type Static } from "typebox";
import type { Db } from "../db.js";
import type { Place } from "./places.js";
import { glossaryOf, termsOf, type TermRecord } from "./terms.js";

/**
 * The glossary check: which words a place's glossary avoids a text uses, each with the Term to use instead. Every Agent
 * save that writes text runs it; it never refuses a save.
 */

export const AvoidedWord = Type.Object({
  word: Type.String({ description: "The avoided word as the text writes it, such as `Tasks`." }),
  term: Type.Object(
    {
      name: Type.String(),
      readable: Type.String({ description: "Its readable form: `Ticket` for a Workspace Term, `CRONK/Ticket` for a Project's." }),
    },
    { description: "The Term to use instead." },
  ),
});
export type AvoidedWord = Static<typeof AvoidedWord>;

/** The texts a save writes: Markdown, such as a body, and plain text, such as a title. */
export interface SavedTexts {
  markdown?: string[];
  plain?: string[];
}

/**
 * The plain text of Markdown that the check reads, as runs: its text, link text included, but not code spans, code
 * blocks, block quotes, raw HTML or link targets (an autolink's text is its target).
 */
export function wordsRead(markdown: string): string[] {
  const texts: string[] = [];
  const walk = (node: Nodes) => {
    if (node.type === "text") texts.push(node.value);
    if (node.type === "blockquote" || !("children" in node)) return;
    if (node.type === "link" && node.children.every((child) => child.type === "text" && child.value === node.url)) return;
    for (const child of node.children) walk(child);
  };
  walk(fromMarkdown(markdown));
  return texts;
}

const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A whole word or phrase anywhere in a text, ignoring case, its spaces matching any run of white space. */
const wholeWord = (word: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}_])${word.trim().split(/\s+/).map(escape).join("\\s+")}(?![\\p{L}\\p{N}_])`, "iu");

/**
 * The avoided words the texts use, once per word ignoring case, in the order they first appear, each with the Term to
 * use: by the place's glossary, a Project's Terms over the Workspace's, or the Workspace's own. A word that is a Term's
 * own name in that glossary never warns.
 */
export async function avoidedWordsIn(db: Db, place: Place, texts: SavedTexts): Promise<AvoidedWord[]> {
  const runs = [...(texts.plain ?? []), ...(texts.markdown ?? []).flatMap(wordsRead)].filter((run) => run.trim() !== "");
  if (runs.length === 0) return [];
  const glossary =
    place.projectId === null
      ? await termsOf(db, place)
      : await glossaryOf(db, { workspaceId: place.workspaceId, projectId: place.projectId });
  if (glossary.every((term) => term.avoid.length === 0)) return [];
  const key = place.projectId === null ? null : await projectKey(db, place.projectId);
  const names = new Set(glossary.map((term) => term.name.toLowerCase()));
  const avoided = new Map<string, TermRecord>();
  for (const term of glossary) {
    for (const word of term.avoid) {
      const lower = word.trim().toLowerCase();
      if (lower !== "" && !names.has(lower) && !avoided.has(lower)) avoided.set(lower, term);
    }
  }

  const found: { at: [number, number]; entry: AvoidedWord }[] = [];
  for (const [lower, term] of avoided) {
    const pattern = wholeWord(lower);
    for (const [index, run] of runs.entries()) {
      const match = pattern.exec(run);
      if (!match) continue;
      const readable = term.projectId === null ? term.name : `${key}/${term.name}`;
      found.push({ at: [index, match.index], entry: { word: match[0], term: { name: term.name, readable } } });
      break;
    }
  }
  return found.sort((a, b) => a.at[0] - b.at[0] || a.at[1] - b.at[1]).map(({ entry }) => entry);
}

async function projectKey(db: Db, projectId: string): Promise<string> {
  const { rows } = await db.query<{ key: string }>("select key from projects where id = $1", [projectId]);
  return rows[0]!.key;
}
