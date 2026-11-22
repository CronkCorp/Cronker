import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { Type, type Static } from "typebox";
import { transaction, type Db, type Tx } from "../db.js";
import { slugColumn } from "../http/readable.js";
import { inReach, type Viewer } from "../identity/viewers.js";

/*
 * The Mention index: the Ticket keys and Term names each Markdown text mentions, recorded in the transaction that
 * saves the text, and recorded again for the texts a Term's creation, rename or removal changes. Kept apart from
 * `tickets.ts`, which loads `runs.ts`, as the modules writing texts (Comments among them) are loaded by it in turn.
 */

/** A Ticket as another Ticket's Relations, parent, Sub-Tickets and Changes name it. */
export const TicketRef = Type.Object({
  id: Type.String({ format: "uuid" }),
  projectId: Type.String({ format: "uuid" }),
  key: Type.String(),
  title: Type.String(),
});
export type TicketRef = Static<typeof TicketRef>;

/** Selects a Ticket as a TicketRef, from `tickets` and its `projects` joined as the given aliases. */
export const ticketRefColumn = (tickets: string, projects: string) =>
  `json_build_object('id', ${tickets}.id, 'projectId', ${tickets}.project_id,
     'key', ${projects}.key || '-' || ${tickets}.number, 'title', ${tickets}.title)`;

/** A Ticket key written in Markdown that names a Ticket of the Workspace. */
export const TicketMention = Type.Object({
  kind: Type.Literal("ticket"),
  text: Type.String({ description: "The key as written, such as `cronk-12`." }),
  key: Type.String({ description: "The Ticket's key, such as `CRONK-12`." }),
  ticketId: Type.String({ format: "uuid" }),
});
export type TicketMention = Static<typeof TicketMention>;

/** A Term's name written in Markdown, with its capitalisation and as a whole word, by the glossary of the text's place. */
export const TermMention = Type.Object({
  kind: Type.Literal("term"),
  text: Type.String({ description: "The name as written, which is the Term's name as the text was last indexed." }),
  termId: Type.String({ format: "uuid" }),
  name: Type.String({ description: "The Term's name now." }),
  projectId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
    description: "The Project whose Term it is, or null for the Workspace's.",
  }),
});
export type TermMention = Static<typeof TermMention>;

/** What a text mentions: a Ticket by its key, or a Term by its name. */
export const Mention = Type.Union([TicketMention, TermMention], {
  description: "A Ticket key or a Term name the text mentions; `kind` says which.",
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
 * The plain text of Markdown, one string per text node, as the web client shows it: never in code spans, code blocks,
 * raw HTML or links, whose text already leads somewhere.
 */
function plainTexts(markdown: string): string[] {
  const texts: string[] = [];
  const walk = (node: Nodes) => {
    if (node.type === "text") texts.push(node.value);
    if (node.type === "link" || node.type === "linkReference" || !("children" in node)) return;
    for (const child of node.children) walk(child);
  };
  walk(fromMarkdown(markdown));
  return texts;
}

/** Ticket keys as written in Markdown, each once, in order of first mention, outside code and links. */
export function keysMentioned(markdown: string): string[] {
  return [...new Set(plainTexts(markdown).flatMap(keysWritten))];
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
 * Records the Ticket keys and Term names a text mentions, replacing what was recorded for it: call it in the
 * transaction that saves the text, with the text as it now reads (for knowledge, its current Version's). A Term's own
 * definition doesn't mention itself.
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
  const written = keysMentioned(markdown);
  if (written.length > 0) {
    await tx.query(
      `insert into mentions (workspace_id, ${column}, target_kind, project_key, number, written, position)
       select $1, $2, 'ticket', upper(split_part(written, '-', 1)), split_part(written, '-', 2)::integer, written,
         position - 1
       from unnest($3::text[]) with ordinality as keys (written, position)`,
      [text.workspaceId, text.id, written],
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
  await insertTermMentions(tx, kind, { ...text, projectId }, markdown, written.length, glossaries);
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
 * Records again the Term names a text mentions, by its place's glossary as it now reads, leaving its Ticket keys be;
 * writes nothing when they are as recorded, so the text keeps its place under Mentioned in.
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

type MentionRow = {
  sourceId: string;
  kind: "ticket" | "term";
  text: string;
  key: string | null;
  ticketId: string | null;
  termId: string | null;
};

/**
 * The Mentions of each text of a kind, by the text's id, in order of first mention: only Tickets and Terms that still
 * exist and that the Viewer may read; anything else stays plain text. Every id given has an entry.
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
  // Terms are looked up only for texts mentioning some, as a database migrated short of Terms has no `terms`.
  const { rows } = await db.query<MentionRow>(
    `select * from (
       select mentions.${column} as "sourceId", 'ticket' as kind, mentions.written as text,
         projects.key || '-' || tickets.number as key, tickets.id as "ticketId", null::uuid as "termId", mentions.position
       from mentions
       join projects on projects.workspace_id = mentions.workspace_id and projects.key = mentions.project_key
       join tickets on tickets.project_id = projects.id and tickets.number = mentions.number
       where mentions.${column} = any($1::uuid[]) and mentions.target_kind = 'ticket' and ${reach.sql}
       union all
       select mentions.${column}, 'term', mentions.written, null, null, mentions.target_term_id, mentions.position
       from mentions
       where mentions.${column} = any($1::uuid[]) and mentions.target_kind = 'term'
     ) found
     order by position`,
    [ids, reach.value],
  );
  const termIds = [...new Set(rows.flatMap((row) => row.termId ?? []))];
  const terms = new Map<string, { name: string; projectId: string | null }>();
  if (termIds.length > 0) {
    const termReach = inReach(viewer, { project: "terms.project_id", workspace: "terms.workspace_id" }, "$2");
    const readable = await db.query<{ id: string; name: string; projectId: string | null }>(
      `select id, name, project_id as "projectId" from terms where id = any($1::uuid[]) and ${termReach.sql}`,
      [termIds, termReach.value],
    );
    for (const term of readable.rows) terms.set(term.id, term);
  }
  for (const row of rows) {
    if (row.kind === "ticket") {
      found.get(row.sourceId)?.push({ kind: "ticket", text: row.text, key: row.key!, ticketId: row.ticketId! });
      continue;
    }
    const term = terms.get(row.termId!);
    if (term) found.get(row.sourceId)?.push({ kind: "term", text: row.text, termId: row.termId!, ...term });
  }
  return found;
}

/** The Mentions of one text. */
export async function mentionsOfOne(db: Db | Tx, viewer: Viewer, kind: MentioningKind, id: string): Promise<Mention[]> {
  return (await mentionsOf(db, viewer, kind, [id])).get(id)!;
}

/** A text that mentions a Ticket or a Term, as its Mentioned in lists it, with what linking to it takes. */
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
  title: Type.String({ description: "Its title; a Term's name; for a Comment, its Ticket's title." }),
  ticket: Type.Union([TicketRef, Type.Null()], {
    description: "The Ticket it is: a Ticket's own, a Comment's or a Report's Ticket; null for other knowledge.",
  }),
  slug: Type.Union([Type.String(), Type.Null()], { description: "A Document's or Report's slug; otherwise null." }),
  number: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()], { description: "A Decision's number; otherwise null." }),
});
export type MentioningText = Static<typeof MentioningText>;

/** What is mentioned: a Ticket by its key, or a Term by its id. */
export type MentionTarget =
  | { kind: "ticket"; id: string; workspaceId: string; key: string }
  | { kind: "term"; id: string; workspaceId: string };

/**
 * The texts mentioning a Ticket or a Term that the Viewer may read, most recently saved first: Tickets' descriptions,
 * Comments, Documents and Reports, Terms and Decisions. The target's own text is left out.
 */
export async function mentionedIn(db: Db | Tx, viewer: Viewer, target: MentionTarget): Promise<MentioningText[]> {
  let hit: string;
  let params: unknown[];
  if (target.kind === "ticket") {
    const [projectKey, number] = target.key.split("-");
    hit = "workspace_id = $1 and target_kind = 'ticket' and project_key = $2 and number = $3::integer";
    params = [target.workspaceId, projectKey, Number(number)];
  } else {
    hit = "workspace_id = $1 and target_kind = 'term' and target_term_id = $2 and $3::integer is null";
    params = [target.workspaceId, target.id, null];
  }
  // Most targets are mentioned nowhere, which this finds without reading every kind of text.
  const { rowCount } = await db.query(`select 1 from mentions where ${hit} limit 1`, params);
  if (rowCount === 0) return [];
  const reach = (project: string, workspace: string) => inReach(viewer, { project, workspace }, "$5").sql;
  const { value } = inReach(viewer, { project: "null", workspace: "null" }, "$5");
  const ref = (tickets: string, projects: string) =>
    `(select ${ticketRefColumn(tickets, projects)} from projects ${projects} where ${projects}.id = ${tickets}.project_id)`;
  const own = (kind: MentionTarget["kind"], column: string) =>
    target.kind === kind ? `${column} <> $4::uuid` : "$4::uuid is not null";
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
       where ${own("ticket", "tickets.id")} and ${reach("tickets.project_id", "tickets.workspace_id")}
       union all
       select hits.seq, 'comment', comments.id, tickets.project_id, tickets.title,
         ${ref("tickets", "ref_projects")}, null, null
       from hits join comments on comments.id = hits.source_comment_id join tickets on tickets.id = comments.ticket_id
       where ${reach("tickets.project_id", "tickets.workspace_id")}
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
       where ${own("term", "terms.id")} and ${reach("terms.project_id", "terms.workspace_id")}
       union all
       select hits.seq, 'decision', decisions.id, decisions.project_id, versions.title, null, null, decisions.number
       from hits join decisions on decisions.id = hits.source_decision_id
       join decision_versions versions on versions.decision_id = decisions.id and versions.number = decisions.version
       where ${reach("decisions.project_id", "decisions.workspace_id")}
     ) texts
     order by seq desc`,
    [...params, target.id, value],
  );
  return rows.map(({ seq: _seq, ...text }) => text);
}

/** Each kind of text, as stored: its id, Workspace, Project and Markdown (for knowledge, its current Version's). */
const storedTexts: Record<MentioningKind, string> = {
  ticket: `select id, workspace_id as "workspaceId", project_id as "projectId", description as markdown from tickets`,
  comment: `select comments.id, comments.workspace_id as "workspaceId", tickets.project_id as "projectId",
      comments.body as markdown
    from comments join tickets on tickets.id = comments.ticket_id`,
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
const backfills = ["mentions", "term-mentions"];

/**
 * Indexes the texts stored before the Mention index existed, or before it indexed Term names, once: migrations 0055
 * and 0056 leave this to do on the next start, as it takes parsing their Markdown. Does nothing on a database
 * migrated short of them, or once done.
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
      for (const [kind, sql] of Object.entries(storedTexts) as [MentioningKind, string][]) {
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
