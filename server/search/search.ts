import { slugColumn } from "../http/readable.js";
import { Type, type Static } from "typebox";
import type { Db } from "../db.js";

/**
 * Search over a Workspace's Tickets, knowledge, Artifacts (by title and description) and Transcripts with Postgres
 * full-text: words matched by their stem in the `english` configuration, written in web-search syntax. Needs no AI
 * service.
 */

export const SnippetPart = Type.Object({
  text: Type.String(),
  match: Type.Boolean({ description: "Whether this part matched the search." }),
});

export const searchKinds = ["ticket", "document", "report", "term", "decision", "artifact", "transcript"] as const;
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
    description:
      "A Ticket's own key, or the key of the Ticket a Report is on or a Transcript's Run was on; null for other kinds.",
  }),
  slug: Type.Union([Type.String(), Type.Null()], {
    description: "A Document's, Report's, Artifact's or Transcript's readable form, as its address takes it; null for other kinds.",
  }),
  number: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()], {
    description: "A Decision's number, within its Project or among the Workspace's own; null for other kinds.",
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
    null as slug, null::integer as number, tickets.description as body, ts_rank(tickets.search, query) as rank
  from tickets join projects on projects.id = tickets.project_id, q
  where tickets.workspace_id = $1 and tickets.search @@ query
  union all
  select case when documents.ticket_id is null then 'document' else 'report' end, documents.id, versions.title,
    documents.project_id, projects.key || '-' || tickets.number,
    ${slugColumn("document", "documents.id", "versions.title")}, null, versions.body, ts_rank(versions.search, query)
  from documents
    join document_versions versions on versions.document_id = documents.id and versions.number = documents.version
    left join tickets on tickets.id = documents.ticket_id
    left join projects on projects.id = tickets.project_id,
    q
  where documents.workspace_id = $1 and versions.search @@ query
  union all
  select 'term', terms.id, versions.name, terms.project_id, null, null, null,
    versions.definition || case when cardinality(versions.avoid) = 0 then ''
      else ' Avoid: ' || array_to_string(versions.avoid, ', ') end,
    ts_rank(versions.search, query)
  from terms join term_versions versions on versions.term_id = terms.id and versions.number = terms.version, q
  where terms.workspace_id = $1 and versions.search @@ query
  union all
  select 'decision', decisions.id, versions.title, decisions.project_id, null, null, decisions.number, versions.body,
    ts_rank(versions.search, query)
  from decisions
    join decision_versions versions on versions.decision_id = decisions.id and versions.number = decisions.version, q
  where decisions.workspace_id = $1 and versions.search @@ query
  union all
  select 'artifact', artifacts.id, versions.title, artifacts.project_id, null,
    ${slugColumn("artifact", "artifacts.id", "versions.title")}, null, versions.description,
    ts_rank(versions.search, query)
  from artifacts
    join artifact_versions versions on versions.artifact_id = artifacts.id and versions.number = artifacts.version, q
  where artifacts.workspace_id = $1 and versions.search @@ query
  union all
  -- A Transcript matches by an entry whose text the whole search matches, and shows the one that matched best. A Run's
  -- is kept with the Run's Ticket and Project; an Agent's own, of no Run, with the Workspace.
  select 'transcript', best.transcript_id,
    case when runs.id is null then 'Transcript of a ' || agents.name || ' session'
      else 'Transcript of the ' || runs.status_name || ' Run' end,
    tickets.project_id, projects.key || '-' || tickets.number,
    ${slugColumn("transcript", "best.transcript_id", "agents.name")}, null, best.text, best.rank
  from (
      select distinct on (entries.transcript_id) entries.transcript_id, transcripts.agent_id, transcripts.run_id,
        entries.text, ts_rank(entries.search, query) as rank
      from transcript_entries entries join transcripts on transcripts.id = entries.transcript_id, q
      where transcripts.workspace_id = $1 and transcripts.deleted_at is null and entries.search @@ query
      order by entries.transcript_id, rank desc, entries.position
    ) best
    join agents on agents.id = best.agent_id
    left join runs on runs.id = best.run_id
    left join tickets on tickets.id = runs.ticket_id
    left join projects on projects.id = tickets.project_id`;

/** How many results of each kind a search gives at most: its best. */
export const perKind = 20;

/**
 * The Workspace's Tickets, knowledge, Artifacts and Transcripts matching the query, best first with Transcripts last, at most
 * `perKind` of each kind, each with a snippet.
 */
export async function search(db: Db, workspaceId: string, input: { q: string; project: string | null; kinds: SearchKind[] }): Promise<SearchResult[]> {
  const { rows } = await db.query<Omit<SearchResult, "snippet"> & { headline: string }>(
    `with q as (select websearch_to_tsquery('english', $2) as query),
     hits as (${hits})
     select kind, id, title, project_id as "projectId", ticket_key as "ticketKey", slug, number,
       -- Where the text beneath the title matched, the snippet shows that; where only the title did, the title.
       case when strpos(in_body, $8) > 0 then in_body
         else ts_headline('english', translate(title, $4, ''), query, $3) end as headline
     from (
       select hits.*, row_number() over (partition by kind order by rank desc, title, id) as place
       from hits, q
       where kind = any($5) and ($6::uuid is null or project_id = $6)
     ) found
       cross join q
       cross join lateral (select ts_headline('english', translate(body, $4, ''), query, $3) as in_body) body_headline
     where place <= $7
     -- Transcripts come after every other kind, however well they match.
     order by kind = 'transcript', rank desc, title, id`,
    [workspaceId, input.q, `StartSel=${start}, StopSel=${stop}`, start + stop, input.kinds, input.project, perKind, start],
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
