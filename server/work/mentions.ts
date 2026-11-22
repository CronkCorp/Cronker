import type { Nodes, Paragraph } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { Type, type Static } from "typebox";
import { sandboxPath } from "../artifacts/sandbox-path.js";
import type { Db, Tx } from "../db.js";
import { slugColumn } from "../http/readable.js";
import { inReach, type Viewer } from "../identity/viewers.js";

/*
 * The Mention index: the Ticket keys each Markdown text mentions, and the Artifacts it embeds, recorded in the
 * transaction that saves the text. Kept apart from `tickets.ts`, which loads `runs.ts`, as the modules writing texts
 * (Comments among them) are loaded by it in turn.
 */

/** A Ticket key written in Markdown that names a Ticket of the Workspace. */
export const TicketMention = Type.Object({
  kind: Type.Literal("ticket", { description: "A Ticket key, outside code and links." }),
  text: Type.String({ description: "The key as written, such as `cronk-12`." }),
  key: Type.String({ description: "The Ticket's key, such as `CRONK-12`." }),
  ticketId: Type.String({ format: "uuid" }),
});
export type TicketMention = Static<typeof TicketMention>;

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

/** What a text mentions: a Ticket by its key, or an Artifact it embeds. */
export const Mention = Type.Union([TicketMention, ArtifactMention]);
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
 * What Markdown mentions, as the web client shows it: the Ticket keys in its text, each once, in order of first
 * mention, never in code spans, code blocks, raw HTML or links, whose text already leads somewhere; and the Artifact
 * addresses alone in their paragraphs, its Embeds, each once, in order.
 */
export function mentioned(markdown: string): { keys: string[]; embeds: string[] } {
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
  return { keys: [...new Set(texts.flatMap(keysWritten))], embeds: [...new Set(embeds)] };
}

/**
 * Records the Ticket keys a text mentions and the Artifacts it embeds, replacing what was recorded for it: call it in
 * the transaction that saves the text, with the text as it now reads (for knowledge, its current Version's). An
 * address naming no Artifact of the text's Workspace, or naming one of its Workspace by another slug, is no Embed.
 */
export async function indexMentions(
  tx: Tx | Db,
  kind: MentioningKind,
  text: { id: string; workspaceId: string },
  markdown: string,
): Promise<void> {
  const column = sourceColumn[kind];
  await tx.query(`delete from mentions where ${column} = $1`, [text.id]);
  const { keys, embeds } = mentioned(markdown);
  if (keys.length > 0) {
    await tx.query(
      `insert into mentions (workspace_id, ${column}, target_kind, project_key, number, written, position)
       select $1, $2, 'ticket', upper(split_part(written, '-', 1)), split_part(written, '-', 2)::integer, written,
         position - 1
       from unnest($3::text[]) with ordinality as keys (written, position)`,
      [text.workspaceId, text.id, keys],
    );
  }
  for (const [index, written] of embeds.entries()) {
    const address = embedAddress(written)!;
    const artifactId = await embeddedArtifact(tx, text.workspaceId, address);
    if (!artifactId) continue;
    await tx.query(
      `insert into mentions (workspace_id, ${column}, target_kind, target_artifact_id, target_version, written, position)
       values ($1, $2, 'artifact', $3, $4, $5, $6)`,
      [text.workspaceId, text.id, artifactId, address.version, written, keys.length + index],
    );
  }
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

/**
 * The Mentions of each text of a kind, by the text's id, in order of first mention: only keys naming a Ticket that
 * still exists and that the Viewer may read, and Embeds of Artifacts the Viewer may read at a Version they have; any
 * other key or address stays plain text. Every id given has an entry.
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
    ...(artifacts?.rows ?? []).map(({ serveKey, page, ...row }) => ({ ...row, url: sandboxPath(serveKey, page) })),
  ].sort((a, b) => a.position - b.position);
  for (const { sourceId, position: _, ...mention } of all) found.get(sourceId)?.push(mention);
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
 * Indexes the texts stored before the Mention index existed, or before it recorded Embeds, once: migrations 0055 and
 * 0057 leave this to do on the next start, as it takes parsing their Markdown. Does nothing on a database migrated
 * short of it, or once done.
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
      ((await client.query("delete from pending_backfills where name in ('mentions', 'embeds')")).rowCount ?? 0) > 0;
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
