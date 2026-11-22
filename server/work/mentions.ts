import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { Type, type Static } from "typebox";
import type { Db, Tx } from "../db.js";
import { inReach, type Viewer } from "../identity/viewers.js";

/*
 * The Mention index: the Ticket keys each Markdown text mentions, recorded in the transaction that saves the text.
 * Kept apart from `tickets.ts`, which loads `runs.ts`, as the modules writing texts (Comments among them) are loaded
 * by it in turn.
 */

/** A Ticket key written in Markdown that names a Ticket of the Workspace. */
export const Mention = Type.Object({
  kind: Type.Literal("ticket", { description: "What the Mention names; only Tickets so far." }),
  text: Type.String({ description: "The key as written, such as `cronk-12`." }),
  key: Type.String({ description: "The Ticket's key, such as `CRONK-12`." }),
  ticketId: Type.String({ format: "uuid" }),
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
 * Ticket keys as written in Markdown, each once, in order of first mention: only in its text, as the web client
 * shows it, so never in code spans, code blocks, raw HTML or links, whose text already leads somewhere.
 */
export function keysMentioned(markdown: string): string[] {
  const texts: string[] = [];
  const walk = (node: Nodes) => {
    if (node.type === "text") texts.push(node.value);
    if (node.type === "link" || node.type === "linkReference" || !("children" in node)) return;
    for (const child of node.children) walk(child);
  };
  walk(fromMarkdown(markdown));
  return [...new Set(texts.flatMap(keysWritten))];
}

/**
 * Records the Ticket keys a text mentions, replacing what was recorded for it: call it in the transaction that saves
 * the text, with the text as it now reads (for knowledge, its current Version's).
 */
export async function indexMentions(
  tx: Tx | Db,
  kind: MentioningKind,
  text: { id: string; workspaceId: string },
  markdown: string,
): Promise<void> {
  const column = sourceColumn[kind];
  await tx.query(`delete from mentions where ${column} = $1`, [text.id]);
  const written = keysMentioned(markdown);
  if (written.length === 0) return;
  await tx.query(
    `insert into mentions (workspace_id, ${column}, target_kind, project_key, number, written, position)
     select $1, $2, 'ticket', upper(split_part(written, '-', 1)), split_part(written, '-', 2)::integer, written,
       position - 1
     from unnest($3::text[]) with ordinality as keys (written, position)`,
    [text.workspaceId, text.id, written],
  );
}

/**
 * The Mentions of each text of a kind, by the text's id, in order of first mention: only keys naming a Ticket that
 * still exists and that the Viewer may read; any other key stays plain text. Every id given has an entry.
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
  const { rows } = await db.query<Mention & { sourceId: string }>(
    `select mentions.${column} as "sourceId", 'ticket' as kind, mentions.written as text,
       projects.key || '-' || tickets.number as key, tickets.id as "ticketId"
     from mentions
     join projects on projects.workspace_id = mentions.workspace_id and projects.key = mentions.project_key
     join tickets on tickets.project_id = projects.id and tickets.number = mentions.number
     where mentions.${column} = any($1::uuid[]) and mentions.target_kind = 'ticket' and ${reach.sql}
     order by mentions.position`,
    [ids, reach.value],
  );
  for (const { sourceId, ...mention } of rows) found.get(sourceId)?.push(mention);
  return found;
}

/** The Mentions of one text. */
export async function mentionsOfOne(db: Db | Tx, viewer: Viewer, kind: MentioningKind, id: string): Promise<Mention[]> {
  return (await mentionsOf(db, viewer, kind, [id])).get(id)!;
}

/** Each kind of text, as stored: its id, Workspace and Markdown (for knowledge, its current Version's). */
const storedTexts: Record<MentioningKind, string> = {
  ticket: `select id, workspace_id as "workspaceId", description as markdown from tickets`,
  comment: `select id, workspace_id as "workspaceId", body as markdown from comments`,
  document: `select documents.id, documents.workspace_id as "workspaceId", versions.body as markdown
    from documents join document_versions versions
      on versions.document_id = documents.id and versions.number = documents.version`,
  term: `select terms.id, terms.workspace_id as "workspaceId", versions.definition as markdown
    from terms join term_versions versions on versions.term_id = terms.id and versions.number = terms.version`,
  decision: `select decisions.id, decisions.workspace_id as "workspaceId", versions.body as markdown
    from decisions join decision_versions versions
      on versions.decision_id = decisions.id and versions.number = decisions.version`,
};

/**
 * Indexes the texts stored before the Mention index existed, once: migration 0053 leaves this to do on the next
 * start, as it takes parsing their Markdown. Does nothing on a database migrated short of it, or once done.
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
      (await client.query("delete from pending_backfills where name = 'mentions'")).rowCount === 1;
    if (pending) {
      for (const [kind, sql] of Object.entries(storedTexts) as [MentioningKind, string][]) {
        const texts = await client.query<{ id: string; workspaceId: string; markdown: string }>(sql);
        for (const text of texts.rows) await indexMentions(client, kind, text, text.markdown);
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
