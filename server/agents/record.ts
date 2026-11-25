import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import { slugColumn } from "../http/readable.js";
import { User, userJson } from "../identity/user.js";
import { inReach, inView, type Viewer } from "../identity/viewers.js";
import { transcriptReadable } from "../transcripts/transcripts.js";
import { changeFields } from "../work/changes.js";
import { literals } from "../literals.js";
import { TicketRef } from "../work/tickets.js";

/**
 * The Agent Record: everything an Agent did across its Workspace, newest first, built from what Cronk already keeps.
 * Each entry is filtered by the Viewer's Access to where it is, and the Record stays for a removed Agent.
 */

const At = Type.String({ format: "date-time" });

const RecordRun = Type.Object({
  kind: Type.Literal("run"),
  id: Type.String({ format: "uuid" }),
  at: Type.String({ format: "date-time", description: "When the Run started." }),
  ticket: TicketRef,
  step: Type.String({ description: "The name of the Step's Status, as it was when the Run started." }),
  model: Type.String(),
  machineModel: Type.Union([Type.String(), Type.Null()], {
    description: "The Machine model it ran on, such as `qwen`; null for a Run on Claude.",
  }),
  state: Type.String(),
  outcome: Type.Union([Type.String(), Type.Null()]),
  endedAt: Type.Union([At, Type.Null()]),
  transcript: Type.Union([Type.Object({ id: Type.String({ format: "uuid" }), slug: Type.String() }), Type.Null()], {
    description: "The Transcript uploaded for its session; null when none was, or once a User deleted it.",
  }),
});

const RecordChange = Type.Object({
  kind: Type.Literal("change"),
  id: Type.String({ format: "uuid" }),
  at: At,
  ticket: TicketRef,
  field: literals(changeFields),
  from: Type.Unknown({ description: "The value before, as a Ticket's timeline gives it." }),
  to: Type.Unknown({ description: "The value after, as a Ticket's timeline gives it." }),
  runId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], { description: "The Run it was made in, if any." }),
});

const RecordComment = Type.Object({
  kind: Type.Literal("comment"),
  id: Type.String({ format: "uuid" }),
  at: At,
  body: Type.String({ description: "Markdown." }),
  replyToId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
  ticket: Type.Union([TicketRef, Type.Null()], { description: "The Ticket it is on; null for a Comment on an Artifact or a Document." }),
  artifact: Type.Union(
    [Type.Object({ id: Type.String({ format: "uuid" }), slug: Type.String(), title: Type.String() }), Type.Null()],
    { description: "The Artifact it is on, by its current title; null for a Comment on a Ticket or a Document." },
  ),
  document: Type.Union(
    [Type.Object({ id: Type.String({ format: "uuid" }), slug: Type.String(), title: Type.String() }), Type.Null()],
    { description: "The Document it is on, a Report included, by its current title; null for a Comment on a Ticket or an Artifact." },
  ),
});

const VersionOf = Type.Union([
  Type.Literal("document"),
  Type.Literal("report"),
  Type.Literal("term"),
  Type.Literal("decision"),
  Type.Literal("artifact"),
]);

const RecordVersion = Type.Object({
  kind: Type.Literal("version"),
  id: Type.String({ description: "The record's id and the Version's number, as `<id>:<number>`." }),
  at: At,
  number: Type.Integer({ minimum: 1, description: "The Version's number." }),
  of: Type.Object({
    kind: VersionOf,
    id: Type.String({ format: "uuid" }),
    projectId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
      description: "Its Project; null for the Workspace's own knowledge.",
    }),
    title: Type.String({ description: "Its title as this Version saved it; a Term's name." }),
    current: Type.String({ description: "Its title now; a Term's name now." }),
    slug: Type.Union([Type.String(), Type.Null()], { description: "A Document's, Report's or Artifact's slug." }),
    decisionNumber: Type.Union([Type.Integer(), Type.Null()], { description: "A Decision's number." }),
    ticket: Type.Union([TicketRef, Type.Null()], { description: "A Report's Ticket." }),
  }),
});

const RecordTranscript = Type.Object({
  kind: Type.Literal("transcript"),
  id: Type.String({ format: "uuid" }),
  at: Type.String({ format: "date-time", description: "When it was last uploaded." }),
  slug: Type.String(),
  sessionId: Type.String(),
  entryCount: Type.Integer({ minimum: 0 }),
  tickets: Type.Array(TicketRef, { description: "The Tickets its Cronk tool calls named, in the order they first named them." }),
});

export const RecordEntry = Type.Union([RecordRun, RecordChange, RecordComment, RecordVersion, RecordTranscript]);
export type RecordEntry = Static<typeof RecordEntry>;

export const AgentRecord = Type.Object({
  agent: Type.Object({
    id: Type.String({ format: "uuid" }),
    workspaceId: Type.String({ format: "uuid" }),
    name: Type.String(),
    owner: User,
    removedAt: Type.Union([At, Type.Null()], { description: "When its Owner removed it; null while it is in use." }),
  }),
  entries: Type.Array(RecordEntry, { description: "Newest first." }),
  next: Type.Union([Type.String(), Type.Null()], { description: "The `before` for the next, older page; null on the last." }),
});
export type AgentRecord = Static<typeof AgentRecord>;

/** Where a page starts: just after the entry with this sort key. */
interface Cursor {
  at: string;
  rank: number;
  tiebreak: string;
  id: string;
}

const encodeCursor = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString("base64url");

function decodeCursor(text: string): Cursor {
  try {
    const cursor = JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as Cursor;
    if (
      typeof cursor.at === "string" &&
      !Number.isNaN(Date.parse(cursor.at)) &&
      Number.isInteger(cursor.rank) &&
      typeof cursor.tiebreak === "string" &&
      /^\d+$/.test(cursor.tiebreak) &&
      typeof cursor.id === "string"
    ) {
      return cursor;
    }
  } catch {
    // Answered below.
  }
  throw new ApiError(400, "invalid_cursor", "`before` isn't a cursor this Record gave.");
}

const ticketRef = (tickets: string, projects: string) =>
  `jsonb_build_object('id', ${tickets}.id, 'projectId', ${tickets}.project_id, 'key', ${projects}.key || '-' || ${tickets}.number, 'title', ${tickets}.title)`;

/**
 * The branches of the Record, one per kind of entry: each yields its sort key (`at`, `rank`, `tiebreak`, `id`) and
 * the entry as JSON, for the Agent in `$1`, filtered by the Viewer's Access bound to `$2`.
 */
function branches(viewer: Viewer): { sql: string; value: string | string[] } {
  const reach = (project: string, workspace: string) => inReach(viewer, { project, workspace }, "$2").sql;
  const transcripts = transcriptReadable(viewer, "transcripts", "$2");
  const versionOf = (
    kind: "document" | "report" | "term" | "decision" | "artifact",
    versions: string,
    records: string,
    recordId: string,
    title: string,
    current: string,
    extra: { slug?: string; decisionNumber?: string; ticket?: string; where?: string; joins?: string },
  ) => `
    select ${versions}.saved_at as at, 3 as rank, ${versions}.number::bigint as tiebreak,
      ${versions}.${recordId}::text || ':' || ${versions}.number as id,
      jsonb_build_object('kind', 'version', 'id', ${versions}.${recordId}::text || ':' || ${versions}.number,
        'number', ${versions}.number,
        'of', jsonb_build_object('kind', '${kind}', 'id', ${records}.id, 'projectId', ${records}.project_id,
          'title', ${title}, 'current', ${current},
          'slug', ${extra.slug ?? "null"}, 'decisionNumber', ${extra.decisionNumber ?? "null"}, 'ticket', ${extra.ticket ?? "null"})) as entry
    from ${versions} join ${records} on ${records}.id = ${versions}.${recordId} ${extra.joins ?? ""}
    where ${versions}.actor_agent_id = $1 ${extra.where ?? ""}
      and ${reach(`${records}.project_id`, `${records}.workspace_id`)}`;
  const currentDocumentTitle = `(select current_versions.title from document_versions current_versions
    where current_versions.document_id = documents.id and current_versions.number = documents.version)`;
  const sql = `
    select runs.started_at as at, 2 as rank, runs.seq as tiebreak, runs.id::text as id,
      jsonb_build_object('kind', 'run', 'id', runs.id, 'ticket', ${ticketRef("tickets", "projects")},
        'step', runs.status_name, 'model', runs.model, 'machineModel', runs.machine_model, 'state', runs.state, 'outcome', runs.outcome,
        'endedAt', runs.ended_at,
        'transcript', (select jsonb_build_object('id', transcripts.id,
            'slug', ${slugColumn("transcript", "transcripts.id", "agents.name")})
          from transcripts join agents on agents.id = transcripts.agent_id
          where transcripts.run_id = runs.id and transcripts.deleted_at is null
          order by transcripts.uploaded_at desc limit 1)) as entry
    from runs join tickets on tickets.id = runs.ticket_id join projects on projects.id = tickets.project_id
    where runs.agent_id = $1 and ${reach("tickets.project_id", "tickets.workspace_id")}
    union all
    select changes.at, 5, changes.seq, changes.id::text,
      jsonb_build_object('kind', 'change', 'id', changes.id, 'ticket', ${ticketRef("tickets", "projects")},
        'field', changes.field, 'from', changes.from_value, 'to', changes.to_value, 'runId', changes.run_id)
    from changes join tickets on tickets.id = changes.ticket_id join projects on projects.id = tickets.project_id
    where changes.actor_agent_id = $1 and ${reach("tickets.project_id", "tickets.workspace_id")}
    union all
    select comments.created_at, 4, comments.seq, comments.id::text,
      jsonb_build_object('kind', 'comment', 'id', comments.id, 'body', comments.body, 'replyToId', comments.reply_to_id,
        'ticket', case when tickets.id is null then null else ${ticketRef("tickets", "projects")} end,
        'artifact', case when artifacts.id is null then null else jsonb_build_object('id', artifacts.id,
          'slug', ${slugColumn("artifact", "artifacts.id", "artifact_titles.title")}, 'title', artifact_titles.title) end,
        'document', case when comment_documents.id is null then null else jsonb_build_object('id', comment_documents.id,
          'slug', ${slugColumn("document", "comment_documents.id", "document_titles.title")}, 'title', document_titles.title) end)
    from comments
    left join tickets on tickets.id = comments.ticket_id left join projects on projects.id = tickets.project_id
    left join artifacts on artifacts.id = comments.artifact_id
    left join artifact_versions artifact_titles
      on artifact_titles.artifact_id = artifacts.id and artifact_titles.number = artifacts.version
    left join documents comment_documents on comment_documents.id = comments.document_id
    left join document_versions document_titles
      on document_titles.document_id = comment_documents.id and document_titles.number = comment_documents.version
    where comments.actor_agent_id = $1
      and (tickets.id is not null and ${reach("tickets.project_id", "tickets.workspace_id")}
        or artifacts.id is not null and ${reach("artifacts.project_id", "artifacts.workspace_id")}
        or comment_documents.id is not null and ${reach("comment_documents.project_id", "comment_documents.workspace_id")})
    union all
    ${versionOf("document", "document_versions", "documents", "document_id", "document_versions.title", currentDocumentTitle, {
      slug: slugColumn("document", "documents.id", currentDocumentTitle),
      where: "and documents.ticket_id is null",
    })}
    union all
    ${versionOf("report", "document_versions", "documents", "document_id", "document_versions.title", currentDocumentTitle, {
      slug: slugColumn("document", "documents.id", currentDocumentTitle),
      ticket: ticketRef("tickets", "projects"),
      joins: "join tickets on tickets.id = documents.ticket_id join projects on projects.id = tickets.project_id",
    })}
    union all
    ${versionOf("term", "term_versions", "terms", "term_id", "term_versions.name",
      "(select current_versions.name from term_versions current_versions where current_versions.term_id = terms.id and current_versions.number = terms.version)",
      {},
    )}
    union all
    ${versionOf("decision", "decision_versions", "decisions", "decision_id", "decision_versions.title",
      "(select current_versions.title from decision_versions current_versions where current_versions.decision_id = decisions.id and current_versions.number = decisions.version)",
      { decisionNumber: "decisions.number" },
    )}
    union all
    ${versionOf("artifact", "artifact_versions", "artifacts", "artifact_id", "artifact_versions.title",
      "(select current_versions.title from artifact_versions current_versions where current_versions.artifact_id = artifacts.id and current_versions.number = artifacts.version)",
      {
        slug: slugColumn("artifact", "artifacts.id",
          "(select current_versions.title from artifact_versions current_versions where current_versions.artifact_id = artifacts.id and current_versions.number = artifacts.version)"),
      },
    )}
    union all
    select transcripts.uploaded_at, 1, 0::bigint, transcripts.id::text,
      jsonb_build_object('kind', 'transcript', 'id', transcripts.id,
        'slug', ${slugColumn("transcript", "transcripts.id", "agents.name")}, 'sessionId', transcripts.session_id,
        'entryCount', (select count(*)::int from transcript_entries where transcript_entries.transcript_id = transcripts.id),
        'tickets', coalesce((select jsonb_agg(${ticketRef("named_tickets", "named_projects")} order by transcript_tickets.position)
          from transcript_tickets join tickets named_tickets on named_tickets.id = transcript_tickets.ticket_id
          join projects named_projects on named_projects.id = named_tickets.project_id
          where transcript_tickets.transcript_id = transcripts.id), '[]'::jsonb))
    from transcripts join agents on agents.id = transcripts.agent_id
    where transcripts.agent_id = $1 and transcripts.run_id is null and transcripts.deleted_at is null and ${transcripts.sql}`;
  return { sql, value: transcripts.value };
}

/** Postgres's JSON keeps timestamps in its own form; the API gives them as ISO strings. */
const iso = (value: unknown): string | null => (value === null || value === undefined ? null : new Date(value as string).toISOString());

function present(entry: Record<string, unknown>, at: Date): RecordEntry {
  const shaped = { ...entry, at: at.toISOString() } as Record<string, unknown>;
  if (shaped.kind === "run") shaped.endedAt = iso(shaped.endedAt);
  return shaped as RecordEntry;
}

export const defaultRecordLimit = 50;
export const maxRecordLimit = 200;

/**
 * A page of the Agent's Record as the Viewer may read it, newest first, older than `before` when given. The Agent
 * must be of a Workspace in the Viewer's view; a removed Agent's Record stays.
 */
export async function agentRecord(
  { db }: Context,
  viewer: Viewer,
  agentId: string,
  { before, limit = defaultRecordLimit }: { before?: string; limit?: number },
): Promise<AgentRecord> {
  const view = inView(viewer, "agents.workspace_id", "$2");
  const { rows: agents } = isUuid(agentId)
    ? await db.query<AgentRecord["agent"] & { removedAt: Date | null }>(
        `select agents.id, agents.workspace_id as "workspaceId", agents.name, ${userJson("owners")} as owner,
           agents.removed_at as "removedAt"
         from agents join users owners on owners.id = agents.owner_id
         where agents.id = $1 and ${view.sql}`,
        [agentId, view.value],
      )
    : { rows: [] };
  const agent = agents[0];
  if (!agent) throw new ApiError(404, "not_found", "No such Agent.");

  const cursor = before === undefined ? null : decodeCursor(before);
  const { sql, value } = branches(viewer);
  const params: unknown[] = [agent.id, value, limit + 1];
  let after = "";
  if (cursor) {
    params.push(cursor.at, cursor.rank, cursor.tiebreak, cursor.id);
    after = "where (entries.at, entries.rank, entries.tiebreak, entries.id) < ($4::timestamptz, $5::int, $6::bigint, $7::text)";
  }
  const { rows } = await db.query<{ at: Date; atText: string; rank: number; tiebreak: string; id: string; entry: Record<string, unknown> }>(
    `select entries.at, entries.at::text as "atText", entries.rank, entries.tiebreak::text as tiebreak, entries.id, entries.entry
     from (${sql}) entries ${after}
     order by entries.at desc, entries.rank desc, entries.tiebreak desc, entries.id desc
     limit $3`,
    params,
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    agent: { ...agent, removedAt: agent.removedAt && agent.removedAt.toISOString() },
    entries: page.map((row) => present(row.entry, row.at)),
    next:
      rows.length > limit && last
        ? encodeCursor({ at: last.atText, rank: last.rank, tiebreak: last.tiebreak, id: last.id })
        : null,
  };
}
