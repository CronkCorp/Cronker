import type { Nodes, Paragraph } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { Type, type Static } from "typebox";
import { sandboxPath } from "../artifacts/sandbox-path.js";
import { transaction, type Db, type Tx } from "../db.js";
import { slugColumn } from "../http/readable.js";
import { inReach, type Viewer } from "../identity/viewers.js";
import { TicketRef, ticketRefColumn } from "./ticket-refs.js";

/*
 * The Mention index: the Ticket and Decision keys and Term names each Markdown text mentions, and the Artifacts it
 * embeds, recorded in the transaction that saves the text, and recorded again for the texts a Term's creation, rename
 * or removal changes. Kept apart from `tickets.ts`, which loads `runs.ts`, as the modules writing texts (Comments
 * among them) are loaded by it in turn.
 */

/** A Ticket key written in Markdown that names a Ticket of the Workspace. */
export const TicketMention = Type.Object({
  kind: Type.Literal("ticket", { description: "A Ticket key, outside code and links." }),
  text: Type.String({ description: "The key as written, such as `cronk-12`." }),
  key: Type.String({ description: "The Ticket's key, such as `CRONK-12`." }),
  ticketId: Type.String({ format: "uuid" }),
});
export type TicketMention = Static<typeof TicketMention>;

/** A Term's name written in Markdown, with its capitalisation and as a whole word, by the glossary of the text's place. */
export const TermMention = Type.Object({
  kind: Type.Literal("term", { description: "A Term's name, outside code and links." }),
  text: Type.String({ description: "The name as written, which is the Term's name as the text was last indexed." }),
  termId: Type.String({ format: "uuid" }),
  name: Type.String({ description: "The Term's name now." }),
  projectId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
    description: "The Project whose Term it is, or null for the Workspace's.",
  }),
});
export type TermMention = Static<typeof TermMention>;
/** A Decision key written in Markdown that names a Decision of the Workspace or of one of its Projects. */
export const DecisionMention = Type.Object({
  kind: Type.Literal("decision"),
  text: Type.String({ description: "The key as written, such as `web-d7` or `d7`." }),
  key: Type.String({ description: "The Decision's key: `WEB-D7` for a Project's, `D7` for the Workspace's own." }),
  decisionId: Type.String({ format: "uuid" }),
  projectId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
    description: "The Decision's Project, or null for the Workspace's own.",
  }),
  number: Type.Integer({ minimum: 1, description: "The Decision's number." }),
});
export type DecisionMention = Static<typeof DecisionMention>;

/** An Embed: an Artifact's address alone in its paragraph, which shows the Artifact in place. */
export const ArtifactMention = Type.Object({
  kind: Type.Literal("artifact", { description: "An Embed: an Artifact's address alone in its paragraph." }),
  text: Type.String({
    description: "The address as written, such as `https://cronk.example.com/acme/artifacts/board-3f9a1b2c?version=2`.",
  }),
  artifactId: Type.String({ format: "uuid" }),
  slug: Type.String({ description: "The Artifact's slug, which its address is built from." }),
  title: Type.String({ description: "The shown Version's title." }),
  version: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()], {
    description: "The Version the address names, or null for the latest.",
  }),
  url: Type.String({
    description: "Where the shown Version's page is served, sandboxed, to show in an iframe with `sandbox=\"allow-scripts\"`.",
  }),
});
export type ArtifactMention = Static<typeof ArtifactMention>;

/** What a text mentions: a Ticket or Decision by its key, a Term by its name, or an Artifact it embeds. */
export const Mention = Type.Union([TicketMention, DecisionMention, TermMention, ArtifactMention], {
  description: "A Ticket or Decision key, a Term name or an Embed of an Artifact the text holds; `kind` says which.",
});
export type Mention = Static<typeof Mention>;

/** The kinds of text that mention: a Ticket's description, a Comment, a Document or Report, a Term or a Decision. */
export type MentioningKind = "ticket" | "comment" | "document" | "term" | "decision";

/** The column of `mentions` naming a text of each kind. */
const sourceColumn: Record<MentioningKind, string> = {
  ticket: "source_ticket_id",
  comment: "source_comment_id",
  document: "source_document_id",
  term: "source_term_id",
  decision: "source_decision_id",
};

const writtenKey = /\b[A-Za-z][A-Za-z0-9]{1,9}-[1-9][0-9]{0,8}\b/g;

/** Ticket keys as written in plain text, each once, in order of first mention. */
export const keysWritten = (text: string) => [...new Set([...text.matchAll(writtenKey)].map((m) => m[0]))];

/**
 * A Ticket key (`WEB-4`), or else a Decision key: a Project's (`WEB-D7`) or the Workspace's own (`D7`), in any letter
 * case. Ticket keys come first, so `D7-3` is the Ticket it names; a Decision key starts after no letter, digit or
 * hyphen, so `WEB-D7` isn't also `D7`. The web client matches with the same boundaries.
 */
const mentionedKey =
  /\b[A-Za-z][A-Za-z0-9]{1,9}-[1-9][0-9]{0,8}\b|(?<![\w-])(?:([A-Za-z][A-Za-z0-9]{1,9})-)?[Dd]([1-9][0-9]{0,8})(?!\w)/g;

/** A key as written in a text, with what it names: a Ticket by Project key and number, a Decision also by none. */
interface WrittenKey {
  kind: "ticket" | "decision";
  written: string;
  /** In upper case as Projects keep it; null for a Decision of the Workspace's own. */
  projectKey: string | null;
  number: number;
}

/** An Artifact's address as an Embed writes it, taken apart. */
export interface EmbedAddress {
  /** The Workspace's slug the path starts with; null for the older `/artifacts/<id>`. */
  workspace: string | null;
  /** The Artifact's slug, or its id. */
  slug: string;
  version: number | null;
}

/**
 * The rich editor keeps a copy of these rules (`web/src/editor/embed-address.ts`), as the web client can't import
 * server modules; `test/editor/embeds.test.ts` checks the two agree.
 *
 * An Artifact's address: `/<workspace>/artifacts/<slug>`, or the older `/artifacts/<id>`, either after Cronk's origin
 * or alone, with `?version=N` naming a Version. Nothing else, so not with any other query or a fragment.
 */
export function embedAddress(written: string): EmbedAddress | undefined {
  if (!/^(https?:\/\/[^/\s]+)?\/\S*$/i.test(written)) return undefined;
  let url: URL;
  try {
    url = new URL(written, "http://cronk.invalid");
  } catch {
    return undefined;
  }
  if (url.hash || url.username || url.password) return undefined;
  const query = [...url.searchParams];
  let version: number | null = null;
  if (query.length > 0) {
    const [[name, value]] = query as [[string, string]];
    if (query.length > 1 || name !== "version" || !/^[1-9][0-9]{0,8}$/.test(value)) return undefined;
    version = Number(value);
  }
  let parts: string[];
  try {
    parts = url.pathname.split("/").slice(1).map(decodeURIComponent);
  } catch {
    return undefined;
  }
  if (parts.length === 3 && parts[1] === "artifacts" && parts[0] && parts[2]) {
    return { workspace: parts[0].toLowerCase(), slug: parts[2], version };
  }
  if (parts.length === 2 && parts[0] === "artifacts" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parts[1]!)) {
    return { workspace: null, slug: parts[1]!.toLowerCase(), version };
  }
  return undefined;
}

/**
 * The address a paragraph holds alone, as written: a bare address, or one as an autolink (`<…>`) whose text is the
 * address itself. A link with words of its own, or anything else beside the address, makes no Embed.
 */
export function addressAlone(paragraph: Paragraph): string | undefined {
  if (paragraph.children.length !== 1) return undefined;
  const [only] = paragraph.children as [Paragraph["children"][number]];
  let written: string | undefined;
  if (only.type === "text") written = only.value.trim();
  else if (only.type === "link" && only.children.length === 1 && only.children[0]!.type === "text" && only.children[0]!.value === only.url) {
    written = only.url;
  }
  return written !== undefined && embedAddress(written) ? written : undefined;
}

/**
 * What Markdown holds, as the web client shows it: its plain text, one string per text node, never in code spans,
 * code blocks, raw HTML or links, whose text already leads somewhere; and the Artifact addresses alone in their
 * paragraphs, its Embeds, each once, in order.
 */
function walked(markdown: string): { texts: string[]; embeds: string[] } {
  const texts: string[] = [];
  const embeds: string[] = [];
  const walk = (node: Nodes) => {
    if (node.type === "paragraph") {
      const address = addressAlone(node);
      if (address !== undefined) {
        embeds.push(address);
        return;
      }
    }
    if (node.type === "text") texts.push(node.value);
    if (node.type === "link" || node.type === "linkReference" || !("children" in node)) return;
    for (const child of node.children) walk(child);
  };
  walk(fromMarkdown(markdown));
  return { texts, embeds: [...new Set(embeds)] };
}

/** The plain text of Markdown, one string per text node, outside code, links and Embeds. */
const plainTexts = (markdown: string) => walked(markdown).texts;

/**
 * What Markdown mentions, as the web client shows it: the Ticket and Decision keys in its text, each once, in order of
 * first mention, outside code and links; and its Embeds, each once, in order.
 */
export function mentioned(markdown: string): { keys: WrittenKey[]; embeds: string[] } {
  const { texts, embeds } = walked(markdown);
  const keys = new Map<string, WrittenKey>();
  for (const text of texts) {
    for (const match of text.matchAll(mentionedKey)) {
      const [written, decisionProject, decisionNumber] = match;
      if (keys.has(written)) continue;
      if (decisionNumber === undefined) {
        const [projectKey, number] = written.split("-");
        keys.set(written, { kind: "ticket", written, projectKey: projectKey!.toUpperCase(), number: Number(number) });
      } else {
        const projectKey = decisionProject?.toUpperCase() ?? null;
        keys.set(written, { kind: "decision", written, projectKey, number: Number(decisionNumber) });
      }
    }
  }
  return { keys: [...keys.values()], embeds };
}

/** A Term a text may mention: one of its place's glossary. */
export interface NamedTerm {
  id: string;
  name: string;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The pattern finding a glossary's names: each with its capitalisation, as a whole word (not next to a letter, digit
 * or underscore, so a name may start or end with punctuation), the longest first where names overlap. The web client
 * links Mentions with the same boundaries.
 */
export function namePattern(names: string[]): RegExp | null {
  if (names.length === 0) return null;
  const longestFirst = [...new Set(names)].sort((a, b) => b.length - a.length);
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${longestFirst.map(escape).join("|")})(?![\\p{L}\\p{N}_])`, "gu");
}

/** The Terms of a glossary whose names Markdown mentions, outside code and links, each once, in order of first mention. */
export function termsMentioned(markdown: string, glossary: NamedTerm[]): NamedTerm[] {
  const pattern = namePattern(glossary.map((term) => term.name));
  if (!pattern) return [];
  const byName = new Map(glossary.map((term) => [term.name, term]));
  const found = new Map<string, NamedTerm>();
  for (const text of plainTexts(markdown)) {
    for (const match of text.matchAll(pattern)) {
      const term = byName.get(match[0])!;
      found.set(term.id, term);
    }
  }
  return [...found.values()];
}

/** The Project of each kind of text, by its id as `$1`; null for the Workspace's own knowledge. */
const projectOf: Record<MentioningKind, string> = {
  ticket: "select project_id from tickets where id = $1",
  comment: "select tickets.project_id from comments join tickets on tickets.id = comments.ticket_id where comments.id = $1",
  document: "select project_id from documents where id = $1",
  term: "select project_id from terms where id = $1",
  decision: "select project_id from decisions where id = $1",
};

/** The Terms of a place's glossary, as `glossaryOf` layers them: a Project's own over the Workspace's, by name ignoring case. */
async function glossaryNames(db: Db | Tx, workspaceId: string, projectId: string | null): Promise<NamedTerm[]> {
  const { rows } = await db.query<NamedTerm>(
    `select terms.id, terms.name from terms
     where terms.workspace_id = $1
       and (terms.project_id = $2
         or (terms.project_id is null and not exists (
           select 1 from terms own where own.project_id = $2 and lower(own.name) = lower(terms.name))))`,
    [workspaceId, projectId],
  );
  return rows;
}

/** Glossaries looked up once while indexing many texts, by their place. */
type Glossaries = Map<string, Promise<NamedTerm[]>>;

/** The text being indexed: its id and Workspace, and, when known, its Project (null for Workspace knowledge). */
interface IndexedText {
  id: string;
  workspaceId: string;
  projectId?: string | null;
}

/**
 * Records the Ticket and Decision keys and Term names a text mentions and the Artifacts it embeds, replacing what was
 * recorded for it: call it in the transaction that saves the text, with the text as it now reads (for knowledge, its
 * current Version's). A Term's own definition doesn't mention itself. An address naming no Artifact of the text's
 * Workspace, or naming one of its Workspace by another slug, is no Embed.
 */
export async function indexMentions(
  tx: Tx | Db,
  kind: MentioningKind,
  text: IndexedText,
  markdown: string,
  glossaries?: Glossaries,
): Promise<void> {
  const column = sourceColumn[kind];
  await tx.query(`delete from mentions where ${column} = $1`, [text.id]);
  const { keys, embeds } = mentioned(markdown);
  if (keys.length > 0) {
    await tx.query(
      `insert into mentions (workspace_id, ${column}, target_kind, project_key, number, written, position)
       select $1, $2, kind, project_key, number, written, position - 1
       from unnest($3::text[], $4::text[], $5::integer[], $6::text[]) with ordinality
         as keys (kind, project_key, number, written, position)`,
      [
        text.workspaceId,
        text.id,
        keys.map((key) => key.kind),
        keys.map((key) => key.projectKey),
        keys.map((key) => key.number),
        keys.map((key) => key.written),
      ],
    );
  }
  let position = keys.length;
  for (const address of embeds) {
    const parsed = embedAddress(address)!;
    const artifactId = await embeddedArtifact(tx, text.workspaceId, parsed);
    if (!artifactId) continue;
    await tx.query(
      `insert into mentions (workspace_id, ${column}, target_kind, target_artifact_id, target_version, written, position)
       values ($1, $2, 'artifact', $3, $4, $5, $6)`,
      [text.workspaceId, text.id, artifactId, parsed.version, address, position++],
    );
  }
  let projectId = text.projectId;
  if (projectId === undefined) {
    // A database migrated short of Terms, as a test of an earlier migration leaves it, has no Term to mention.
    const { rows } = await tx.query<{ projectId: string | null; termsIndexed: boolean }>(
      `select (${projectOf[kind]}) as "projectId", to_regclass('terms') is not null as "termsIndexed"`,
      [text.id],
    );
    if (!rows[0]!.termsIndexed) return;
    projectId = rows[0]!.projectId;
  }
  await insertTermMentions(tx, kind, { ...text, projectId }, markdown, position, glossaries);
}
/**
 * The Artifact of the Workspace an address names, by its slug as the API reads one: its whole id, or the start of it
 * at the slug's end where no other Artifact's id starts the same. The address's Workspace slug must be this one's.
 */
async function embeddedArtifact(tx: Tx | Db, workspaceId: string, address: EmbedAddress): Promise<string | undefined> {
  if (address.workspace !== null) {
    const { rowCount } = await tx.query("select 1 from workspaces where id = $1 and slug = $2", [workspaceId, address.workspace]);
    if (rowCount === 0) return undefined;
  }
  const whole = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(address.slug)?.[1];
  if (whole) {
    const { rows } = await tx.query<{ id: string }>("select id from artifacts where id = $1 and workspace_id = $2", [
      whole.toLowerCase(),
      workspaceId,
    ]);
    return rows[0]?.id;
  }
  const short = /(?:^|-)([0-9a-f]{8,32})$/i.exec(address.slug)?.[1]?.toLowerCase();
  if (!short) return undefined;
  const asId = (hex: string) => hex.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
  const { rows } = await tx.query<{ id: string }>(
    `select id from artifacts where id between $1 and $2 and workspace_id = $3
       and (select count(*) from artifacts others where others.id between $1 and $2) = 1`,
    [asId(short.padEnd(32, "0")), asId(short.padEnd(32, "f")), workspaceId],
  );
  return rows[0]?.id;
}

/** The Terms a text mentions by its place's glossary, leaving out a Term's own name in its definition. */
async function termsOfText(
  tx: Tx | Db,
  kind: MentioningKind,
  text: IndexedText & { projectId: string | null },
  markdown: string,
  glossaries?: Glossaries,
): Promise<NamedTerm[]> {
  const place = `${text.workspaceId} ${text.projectId ?? "workspace"}`;
  let glossary = glossaries?.get(place);
  if (!glossary) {
    glossary = glossaryNames(tx, text.workspaceId, text.projectId);
    glossaries?.set(place, glossary);
  }
  return termsMentioned(markdown, (await glossary).filter((term) => kind !== "term" || term.id !== text.id));
}

async function insertTermMentions(
  tx: Tx | Db,
  kind: MentioningKind,
  text: IndexedText & { projectId: string | null },
  markdown: string,
  after: number,
  glossaries?: Glossaries,
  terms?: NamedTerm[],
): Promise<void> {
  terms ??= await termsOfText(tx, kind, text, markdown, glossaries);
  if (terms.length === 0) return;
  await tx.query(
    `insert into mentions (workspace_id, ${sourceColumn[kind]}, target_kind, target_term_id, written, position)
     select $1, $2, 'term', term_id, written, $5 + position - 1
     from unnest($3::uuid[], $4::text[]) with ordinality as terms (term_id, written, position)`,
    [text.workspaceId, text.id, terms.map((term) => term.id), terms.map((term) => term.name), after],
  );
}

/**
 * Records again the Term names a text mentions, by its place's glossary as it now reads, leaving its keys and Embeds
 * be; writes nothing when they are as recorded, so the text keeps its place under Mentioned in.
 */
async function reindexTermMentions(tx: Tx, kind: MentioningKind, text: StoredText, glossaries: Glossaries): Promise<void> {
  const column = sourceColumn[kind];
  const terms = await termsOfText(tx, kind, text, text.markdown, glossaries);
  const { rows } = await tx.query<{ termId: string | null; written: string }>(
    `select target_term_id as "termId", written from mentions where ${column} = $1 order by position`,
    [text.id],
  );
  const recorded = rows.filter((row) => row.termId !== null);
  const same =
    recorded.length === terms.length &&
    recorded.every((row, index) => row.termId === terms[index]!.id && row.written === terms[index]!.name);
  if (same) return;
  await tx.query(`delete from mentions where ${column} = $1 and target_kind = 'term'`, [text.id]);
  await insertTermMentions(tx, kind, text, text.markdown, rows.length - recorded.length, glossaries, terms);
}

/**
 * The Mentions of each text of a kind, by the text's id, in order of first mention: only keys naming a Ticket or
 * Decision and Terms that still exist and that the Viewer may read, and Embeds of Artifacts the Viewer may read at a
 * Version they have; anything else stays plain text. Every id given has an entry.
 */
export async function mentionsOf(
  db: Db | Tx,
  viewer: Viewer,
  kind: MentioningKind,
  ids: string[],
): Promise<Map<string, Mention[]>> {
  const found = new Map(ids.map((id) => [id, [] as Mention[]]));
  if (ids.length === 0) return found;
  const column = sourceColumn[kind];
  const reach = inReach(viewer, { project: "tickets.project_id", workspace: "tickets.workspace_id" }, "$2");
  const tickets = await db.query<TicketMention & { sourceId: string; position: number }>(
    `select mentions.${column} as "sourceId", mentions.position, 'ticket' as kind, mentions.written as text,
       projects.key || '-' || tickets.number as key, tickets.id as "ticketId"
     from mentions
     join projects on projects.workspace_id = mentions.workspace_id and projects.key = mentions.project_key
     join tickets on tickets.project_id = projects.id and tickets.number = mentions.number
     where mentions.${column} = any($1::uuid[]) and mentions.target_kind = 'ticket' and ${reach.sql}`,
    [ids, reach.value],
  );
  const decisionReach = inReach(viewer, { project: "decisions.project_id", workspace: "decisions.workspace_id" }, "$2");
  const decisions = await db.query<DecisionMention & { sourceId: string; position: number }>(
    `select mentions.${column} as "sourceId", mentions.position, 'decision' as kind, mentions.written as text,
       concat(projects.key || '-', 'D', decisions.number) as key, decisions.id as "decisionId",
       decisions.project_id as "projectId", decisions.number
     from mentions
     left join projects on projects.workspace_id = mentions.workspace_id and projects.key = mentions.project_key
     join decisions on decisions.workspace_id = mentions.workspace_id and decisions.number = mentions.number
       and (decisions.project_id = projects.id or (mentions.project_key is null and decisions.project_id is null))
     where mentions.${column} = any($1::uuid[]) and mentions.target_kind = 'decision' and ${decisionReach.sql}`,
    [ids, decisionReach.value],
  );
  // Terms are read only for texts mentioning some, as a database migrated short of Terms has no `terms`.
  const { rowCount: naming } = await db.query(
    `select 1 from mentions where ${column} = any($1::uuid[]) and target_kind = 'term' limit 1`,
    [ids],
  );
  const termReach = inReach(viewer, { project: "terms.project_id", workspace: "terms.workspace_id" }, "$2");
  const terms = !naming ? undefined : await db.query<TermMention & { sourceId: string; position: number }>(
    `select mentions.${column} as "sourceId", mentions.position, 'term' as kind, mentions.written as text,
       terms.id as "termId", terms.name, terms.project_id as "projectId"
     from mentions
     join terms on terms.id = mentions.target_term_id
     where mentions.${column} = any($1::uuid[]) and mentions.target_kind = 'term' and ${termReach.sql}`,
    [ids, termReach.value],
  );
  // Most texts embed nothing, which this finds without reading Artifacts.
  const { rowCount: embedding } = await db.query(
    `select 1 from mentions where ${column} = any($1::uuid[]) and target_kind = 'artifact' limit 1`,
    [ids],
  );
  const artifactReach = inReach(viewer, { project: "artifacts.project_id", workspace: "artifacts.workspace_id" }, "$2");
  const artifacts = !embedding ? undefined : await db.query<Omit<ArtifactMention, "url"> & { sourceId: string; position: number; serveKey: string; page: string }>(
    `select mentions.${column} as "sourceId", mentions.position, 'artifact' as kind, mentions.written as text,
       artifacts.id as "artifactId", ${slugColumn("artifact", "artifacts.id", "latest.title")} as slug,
       shown.title, mentions.target_version as version, shown.serve_key as "serveKey", shown.page
     from mentions
     join artifacts on artifacts.id = mentions.target_artifact_id
     join artifact_versions latest on latest.artifact_id = artifacts.id and latest.number = artifacts.version
     join artifact_versions shown
       on shown.artifact_id = artifacts.id and shown.number = coalesce(mentions.target_version, artifacts.version)
     where mentions.${column} = any($1::uuid[]) and mentions.target_kind = 'artifact' and ${artifactReach.sql}`,
    [ids, artifactReach.value],
  );
  const all = [
    ...tickets.rows,
    ...decisions.rows,
    ...(terms?.rows ?? []),
    ...(artifacts?.rows ?? []).map(({ serveKey, page, ...row }) => ({ ...row, url: sandboxPath(serveKey, page) })),
  ].sort((a, b) => a.position - b.position);
  for (const { sourceId, position: _, ...mention } of all) found.get(sourceId)?.push(mention);
  return found;
}

/** The Mentions of one text. */
export async function mentionsOfOne(db: Db | Tx, viewer: Viewer, kind: MentioningKind, id: string): Promise<Mention[]> {
  return (await mentionsOf(db, viewer, kind, [id])).get(id)!;
}

/** A text that mentions a Ticket, Decision or Term, as its Mentioned in lists it, with what linking to it takes. */
export const MentioningText = Type.Object({
  kind: Type.Union(
    [
      Type.Literal("ticket"),
      Type.Literal("comment"),
      Type.Literal("document"),
      Type.Literal("report"),
      Type.Literal("term"),
      Type.Literal("decision"),
    ],
    { description: "A Ticket's description, a Comment, a Document, a Report, a Term's definition or a Decision's body." },
  ),
  id: Type.String({ format: "uuid", description: "The Ticket's, Comment's, Document's, Report's, Term's or Decision's." }),
  projectId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
    description: "Its Project, or null for the Workspace's own knowledge.",
  }),
  title: Type.String({
    description: "Its title; a Term's name; for a Comment, its Ticket's title, or for a Comment on an Artifact the Artifact's.",
  }),
  ticket: Type.Union([TicketRef, Type.Null()], {
    description:
      "The Ticket it is: a Ticket's own, a Comment's or a Report's Ticket; null for a Comment on an Artifact and other knowledge.",
  }),
  slug: Type.Union([Type.String(), Type.Null()], {
    description: "A Document's or Report's slug, or for a Comment on an Artifact the Artifact's; otherwise null.",
  }),
  number: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()], { description: "A Decision's number; otherwise null." }),
});
export type MentioningText = Static<typeof MentioningText>;

/**
 * What a Mentioned in list is for: a Ticket or a Decision, by the key texts write (its Project's key, in upper case,
 * or null for a Decision of the Workspace's own, and its number), or a Term; each with its id, so its own text is left
 * out.
 */
export type MentionTarget =
  | { kind: "ticket" | "decision"; id: string; workspaceId: string; projectKey: string | null; number: number }
  | { kind: "term"; id: string; workspaceId: string };

/**
 * Mentioned in: the texts mentioning a Ticket or Decision, by its key, or a Term, that the Viewer may read, most
 * recently saved first: Tickets' descriptions, Comments, Documents and Reports, Terms and Decisions. Its own text is
 * left out.
 */
export async function mentionedIn(db: Db | Tx, viewer: Viewer, target: MentionTarget): Promise<MentioningText[]> {
  let hit: string;
  let params: unknown[];
  if (target.kind === "term") {
    hit = "workspace_id = $1 and target_kind = $2 and target_term_id = $3::uuid and $4::integer is null";
    params = [target.workspaceId, target.kind, target.id, null];
  } else {
    // Spelled out for a Workspace's own Decision, so either way the index on the key serves it.
    const projectKey = target.projectKey === null ? "project_key is null and $3::text is null" : "project_key = $3";
    hit = `workspace_id = $1 and target_kind = $2 and ${projectKey} and number = $4`;
    params = [target.workspaceId, target.kind, target.projectKey, target.number];
  }
  // Most targets are mentioned nowhere, which this finds without reading every kind of text.
  const { rowCount } = await db.query(`select 1 from mentions where ${hit} limit 1`, params);
  if (rowCount === 0) return [];
  const reach = (project: string, workspace: string) => inReach(viewer, { project, workspace }, "$6").sql;
  const { value } = inReach(viewer, { project: "null", workspace: "null" }, "$6");
  const ref = (tickets: string, projects: string) =>
    `(select ${ticketRefColumn(tickets, projects)} from projects ${projects} where ${projects}.id = ${tickets}.project_id)`;
  const { rows } = await db.query<MentioningText & { seq?: unknown }>(
    `with hits as (
       select source_ticket_id, source_comment_id, source_document_id, source_term_id, source_decision_id,
         max(id) as seq
       from mentions where ${hit}
       group by source_ticket_id, source_comment_id, source_document_id, source_term_id, source_decision_id
     )
     select * from (
       select hits.seq, 'ticket' as kind, tickets.id, tickets.project_id as "projectId", tickets.title,
         ${ref("tickets", "ref_projects")} as ticket, null as slug, null::integer as number
       from hits join tickets on tickets.id = hits.source_ticket_id
       where tickets.id <> $5 and ${reach("tickets.project_id", "tickets.workspace_id")}
       union all
       select hits.seq, 'comment', comments.id, tickets.project_id, tickets.title,
         ${ref("tickets", "ref_projects")}, null, null
       from hits join comments on comments.id = hits.source_comment_id join tickets on tickets.id = comments.ticket_id
       where ${reach("tickets.project_id", "tickets.workspace_id")}
       union all
       select hits.seq, 'comment', comments.id, artifacts.project_id, versions.title, null,
         ${slugColumn("artifact", "artifacts.id", "versions.title")}, null
       from hits join comments on comments.id = hits.source_comment_id join artifacts on artifacts.id = comments.artifact_id
       join artifact_versions versions on versions.artifact_id = artifacts.id and versions.number = artifacts.version
       where ${reach("artifacts.project_id", "artifacts.workspace_id")}
       union all
       select hits.seq, case when documents.ticket_id is null then 'document' else 'report' end, documents.id,
         documents.project_id, versions.title,
         (select ${ticketRefColumn("report_tickets", "report_projects")} from tickets report_tickets
          join projects report_projects on report_projects.id = report_tickets.project_id
          where report_tickets.id = documents.ticket_id),
         ${slugColumn("document", "documents.id", "versions.title")}, null
       from hits join documents on documents.id = hits.source_document_id
       join document_versions versions on versions.document_id = documents.id and versions.number = documents.version
       where ${reach("documents.project_id", "documents.workspace_id")}
       union all
       select hits.seq, 'term', terms.id, terms.project_id, terms.name, null, null, null
       from hits join terms on terms.id = hits.source_term_id
       where terms.id <> $5 and ${reach("terms.project_id", "terms.workspace_id")}
       union all
       select hits.seq, 'decision', decisions.id, decisions.project_id, versions.title, null, null, decisions.number
       from hits join decisions on decisions.id = hits.source_decision_id
       join decision_versions versions on versions.decision_id = decisions.id and versions.number = decisions.version
       where decisions.id <> $5 and ${reach("decisions.project_id", "decisions.workspace_id")}
     ) texts
     order by seq desc`,
    [...params, target.id, value],
  );
  return rows.map(({ seq: _seq, ...text }) => text);
}

/** Each kind of text, as stored: its id, Workspace, Project and Markdown (for knowledge, its current Version's). */
const storedTexts: Record<MentioningKind, string> = {
  ticket: `select id, workspace_id as "workspaceId", project_id as "projectId", description as markdown from tickets`,
  comment: `select comments.id, comments.workspace_id as "workspaceId",
      coalesce(tickets.project_id, artifacts.project_id) as "projectId", comments.body as markdown
    from comments left join tickets on tickets.id = comments.ticket_id
    left join artifacts on artifacts.id = comments.artifact_id`,
  document: `select documents.id, documents.workspace_id as "workspaceId", documents.project_id as "projectId",
      versions.body as markdown
    from documents join document_versions versions
      on versions.document_id = documents.id and versions.number = documents.version`,
  term: `select terms.id, terms.workspace_id as "workspaceId", terms.project_id as "projectId",
      versions.definition as markdown
    from terms join term_versions versions on versions.term_id = terms.id and versions.number = terms.version`,
  decision: `select decisions.id, decisions.workspace_id as "workspaceId", decisions.project_id as "projectId",
      versions.body as markdown
    from decisions join decision_versions versions
      on versions.decision_id = decisions.id and versions.number = decisions.version`,
};

/** The row each kind of text is saved through, which a save locks, so indexing it again waits for a save under way. */
const lockedRow: Record<MentioningKind, string> = {
  ticket: "tickets",
  comment: "comments",
  document: "documents",
  term: "terms",
  decision: "decisions",
};

/** A Comment as stored before Comments on Artifacts, as a database migrated short of them keeps it. */
const storedTicketComments = `select comments.id, comments.workspace_id as "workspaceId", tickets.project_id as "projectId",
    comments.body as markdown
  from comments join tickets on tickets.id = comments.ticket_id`;

type StoredText = { id: string; workspaceId: string; projectId: string | null; markdown: string };

/** Where texts are indexed again: a Workspace's every text, or one Project's. */
export interface IndexScope {
  workspaceId: string;
  /** Null for every text of the Workspace, its Projects' among them. */
  projectId: string | null;
}

/** How many texts are indexed again in one transaction. */
const batchSize = 100;

/**
 * Indexes again every text of a scope, by the glossaries as they read now: after a Term is created, renamed or
 * removed, its Workspace's texts for a Workspace Term, its Project's for a Project Term. In short transactions, each
 * locking its texts so a save under way finishes first, so it may run while texts are saved.
 */
export async function reindexMentions(db: Db, scope: IndexScope): Promise<void> {
  for (const kind of Object.keys(storedTexts) as MentioningKind[]) {
    const { rows } = await db.query<{ id: string }>(
      `select id from (${storedTexts[kind]}) texts
       where "workspaceId" = $1 and ($2::uuid is null or "projectId" = $2) order by id`,
      [scope.workspaceId, scope.projectId],
    );
    for (let start = 0; start < rows.length; start += batchSize) {
      const ids = rows.slice(start, start + batchSize).map((row) => row.id);
      await transaction(db, async (tx) => {
        await tx.query(`select 1 from ${lockedRow[kind]} where id = any($1::uuid[]) order by id for update`, [ids]);
        const texts = await tx.query<StoredText>(`select * from (${storedTexts[kind]}) texts where id = any($1::uuid[])`, [
          ids,
        ]);
        const glossaries: Glossaries = new Map();
        for (const text of texts.rows) await reindexTermMentions(tx, kind, text, glossaries);
      });
    }
  }
}

/** The backfills of the Mention index, each recorded by a migration in `pending_backfills` and done once. */
const backfills = ["mentions", "embeds", "decision-mentions", "term-mentions"];

/**
 * Indexes the texts stored before the Mention index existed, before it recorded Embeds, Decision keys or Term names,
 * once: migrations 0055, 0057, 0068 and 0070 leave this to do on the next start, as it takes parsing their Markdown.
 * Does nothing on a database migrated short of them, or once done.
 */
export async function backfillMentions(db: Db): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<{ pending: string | null }>(
      "select to_regclass('pending_backfills')::text as pending",
    );
    const pending =
      rows[0]!.pending !== null &&
      ((await client.query("delete from pending_backfills where name = any($1::text[])", [backfills])).rowCount ?? 0) > 0;
    if (pending) {
      const glossaries: Glossaries = new Map();
      const { rowCount: artifactComments } = await client.query(
        "select 1 from information_schema.columns where table_name = 'comments' and column_name = 'artifact_id'",
      );
      const texts = { ...storedTexts, ...(artifactComments ? {} : { comment: storedTicketComments }) };
      for (const [kind, sql] of Object.entries(texts) as [MentioningKind, string][]) {
        const texts = await client.query<StoredText>(sql);
        for (const text of texts.rows) await indexMentions(client, kind, text, text.markdown, glossaries);
      }
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
