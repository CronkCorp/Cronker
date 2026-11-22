import { Type, type Static } from "typebox";
import type { Db } from "../db.js";
import { ApiError } from "../http/errors.js";
import { accessOf, type Viewer } from "../identity/viewers.js";
import { decisionsWithBodiesOf, type DecisionRecord as Decision } from "./decisions.js";
import type { Place } from "./places.js";
import { glossaryOf, termsOf, type TermRecord as Term } from "./terms.js";

/**
 * A Project's or the Workspace's knowledge as files for a Repository: `GLOSSARY.md` with its glossary, and
 * `docs/adr/NNNN-<slug>.md` for each of its Decisions. Cronk only hands the files out; it never commits them.
 */

export const ExportedFile = Type.Object({
  path: Type.String({ description: "Where the file goes in a Repository, such as `GLOSSARY.md` or `docs/adr/0001-use-postgres.md`." }),
  content: Type.String({ description: "The file's Markdown." }),
});
export type ExportedFile = Static<typeof ExportedFile>;

export const Export = Type.Object({
  files: Type.Array(ExportedFile, { description: "`GLOSSARY.md` first, then each Decision's file by number." }),
});
export type Export = Static<typeof Export>;

/** Text set inside Markdown's emphasis or link text, its markup characters escaped so they show as typed. */
const escapeInline = (text: string) => text.replace(/[\\*_[\]`]/g, (c) => `\\${c}`);

/** A glossary as Markdown: each Term's name in bold, its definition, then the words to avoid, each shown as typed. */
function glossaryFile(terms: Term[]): ExportedFile {
  const entries = terms.map((term) => {
    const lines = [`**${escapeInline(term.name)}**:`];
    if (term.definition.trim()) lines.push(term.definition.trim());
    if (term.avoid.length > 0) lines.push(`_Avoid_: ${term.avoid.map(escapeInline).join(", ")}`);
    return lines.join("\n");
  });
  return { path: "GLOSSARY.md", content: ["# Glossary", ...entries].join("\n\n") + "\n" };
}

/** Text as its ASCII letters and digits, accents dropped, each run of anything else one hyphen, none at either end. */
export function hyphenate(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** A Decision's number in four digits, as its file name starts. */
const fourDigits = (decision: Pick<Decision, "number">) => String(decision.number).padStart(4, "0");

/** A Decision's file name: its number in four digits, then its title as lowercase ASCII words joined by hyphens. */
function decisionFileName(decision: Pick<Decision, "number" | "title">): string {
  const slug = hyphenate(decision.title.toLowerCase()).slice(0, 60).replace(/-+$/, "");
  return `${fourDigits(decision)}-${slug || "decision"}.md`;
}

/** A Decision as Markdown: its title, its status, naming the Decision replacing it while superseded, then its body. */
function decisionFile(decision: Decision, byId: Map<string, Decision>): ExportedFile {
  const replacement = decision.supersededById ? byId.get(decision.supersededById) : undefined;
  const status = replacement
    ? `superseded by [${fourDigits(replacement)} ${escapeInline(replacement.title)}](${decisionFileName(replacement)})`
    : decision.status;
  const parts = [`# ${decision.title}`, `Status: ${status}`];
  if (decision.body.trim()) parts.push(decision.body.trim());
  return { path: `docs/adr/${decisionFileName(decision)}`, content: parts.join("\n\n") + "\n" };
}

/**
 * The place's export. A Project's `GLOSSARY.md` holds its glossary, its own Terms over the Workspace's, and its
 * `docs/adr/` only its own Decisions; the Workspace's holds the Workspace's own Terms and Decisions. A superseded
 * Decision's replacement is always of the same place, so its link resolves within the export. It holds only what the
 * Viewer can read: the Project's export is found only in reach, and the Workspace's own knowledge, by the Workspace's
 * Agent Access, may be out of an Agent's reach, which leaves the Workspace's Terms out of a Project's glossary and the
 * Workspace's export not found.
 */
export async function exportOf(db: Db, viewer: Viewer, place: Place): Promise<Export> {
  const workspaceKnowledge = (await accessOf(db, viewer, { workspaceId: place.workspaceId, projectId: null })) !== "none";
  if (!place.projectId && !workspaceKnowledge) throw new ApiError(404, "not_found", "No such Workspace.");
  const terms = !place.projectId
    ? await termsOf(db, place)
    : workspaceKnowledge
      ? await glossaryOf(db, { ...place, projectId: place.projectId })
      : await termsOf(db, place);
  const decisions = await decisionsWithBodiesOf(db, place);
  const byId = new Map(decisions.map((decision) => [decision.id, decision]));
  return { files: [glossaryFile(terms), ...decisions.map((decision) => decisionFile(decision, byId))] };
}
