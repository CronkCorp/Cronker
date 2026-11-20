import { Type, type Static } from "typebox";
import type { Db } from "../db.js";

/**
 * Search over a Workspace's Tickets and knowledge with Postgres full-text: words matched by their stem in the
 * `english` configuration, written in web-search syntax. Needs no AI service.
 */

export const SnippetPart = Type.Object({
  text: Type.String(),
  match: Type.Boolean({ description: "Whether this part matched the search." }),
});

export const searchKinds = ["ticket", "document", "report", "term", "decision"] as const;
export type SearchKind = (typeof searchKinds)[number];
export const SearchKind = Type.Union(searchKinds.map((kind) => Type.Literal(kind)));

export const SearchResult = Type.Object({
  kind: SearchKind,
  id: Type.String({ format: "uuid" }),
  title: Type.String(),
  projectId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
    description: "Its Project, or null for the Workspace's own knowledge.",
  }),
  ticketKey: Type.Union([Type.String(), Type.Null()], {
    description: "A Ticket's own key, or the key of the Ticket a Report is on; null for other kinds.",
  }),
  snippet: Type.Array(SnippetPart, {
    description: "Where the result matched, in parts, the matching words marked.",
  }),
});
export type SearchResult = Static<typeof SearchResult>;

// Marks around matched words in `ts_headline`'s output; stripped from the text searched so they can't be forged.
const start = "\u0001";
const stop = "\u0002";

const hits = `
  select 'ticket' as kind, tickets.id, tickets.title, tickets.project_id, projects.key || '-' || tickets.number as ticket_key,
    tickets.description as body, ts_rank(tickets.search, query) as rank
  from tickets join projects on projects.id = tickets.project_id, q
  where tickets.workspace_id = $1 and tickets.search @@ query
  union all
  select case when documents.ticket_id is null then 'document' else 'report' end, documents.id, versions.title,
    documents.project_id, projects.key || '-' || tickets.number, versions.body, ts_rank(versions.search, query)
  from documents
    join document_versions versions on versions.document_id = documents.id and versions.number = documents.version
    left join tickets on tickets.id = documents.ticket_id
    left join projects on projects.id = tickets.project_id,
    q
  where documents.workspace_id = $1 and versions.search @@ query
  union all
  select 'term', terms.id, versions.name, terms.project_id, null, versions.definition, ts_rank(versions.search, query)
  from terms join term_versions versions on versions.term_id = terms.id and versions.number = terms.version, q
  where terms.workspace_id = $1 and versions.search @@ query
  union all
  select 'decision', decisions.id, versions.title, decisions.project_id, null, versions.body,
    ts_rank(versions.search, query)
  from decisions
    join decision_versions versions on versions.decision_id = decisions.id and versions.number = decisions.version, q
  where decisions.workspace_id = $1 and versions.search @@ query`;

/** How many results of each kind a search gives at most: its best. */
export const perKind = 20;

/** The Workspace's Tickets and knowledge matching the query, best first and at most `perKind` of each kind, each with a snippet. */
export async function search(db: Db, workspaceId: string, input: { q: string; project: string | null; kinds: SearchKind[] }): Promise<SearchResult[]> {
  const { rows } = await db.query<Omit<SearchResult, "snippet"> & { headline: string }>(
    `with q as (select websearch_to_tsquery('english', $2) as query),
     hits as (${hits})
     select kind, id, title, project_id as "projectId", ticket_key as "ticketKey",
       ts_headline('english', translate(case when to_tsvector('english', body) @@ query then body else title end, $4, ''),
         query, $3) as headline
     from (
       select hits.*, row_number() over (partition by kind order by rank desc, title, id) as place
       from hits, q
       where kind = any($5) and ($6::uuid is null or project_id = $6)
     ) found, q
     where place <= $7
     order by rank desc, title, id`,
    [workspaceId, input.q, `StartSel=${start}, StopSel=${stop}`, start + stop, input.kinds, input.project, perKind],
  );
  return rows.map(({ headline, ...row }) => ({ ...row, snippet: parts(headline) }));
}

/** A headline's text split at its marks into parts, each saying whether it matched. */
function parts(headline: string): SearchResult["snippet"] {
  const result: SearchResult["snippet"] = [];
  for (const [index, piece] of headline.split(new RegExp(`[${start}${stop}]`)).entries()) {
    if (piece) result.push({ text: piece, match: index % 2 === 1 });
  }
  return result;
}
