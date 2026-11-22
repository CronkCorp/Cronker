import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { transaction, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import { slugColumn, slugDescription } from "../http/readable.js";
import { ownerName, type AgentCaller } from "../agents/tokens.js";
import type { Caller } from "../identity/callers.js";
import { inView, type Viewer } from "../identity/viewers.js";
import { megabyte } from "../config.js";
import { recordChanges } from "../work/changes.js";
import { findTicketRow, keysWritten, mentionsInEach, ticketNotFound } from "../work/tickets.js";
import { scrubText, scrubValue } from "./scrubbing.js";

/**
 * Transcripts (ADR 0006): the record of an agent's conversation, converted on arrival from its source's format
 * into one list of entries and stored in Postgres; no raw file is kept. A Transcript belongs to the Agent that
 * uploaded it, keyed by its source session, and to the Run that ran in that session, if any. One of no Run, such as
 * Claude Code connected by hand, links to each Ticket its Cronk tool calls name. Uploading the same session again
 * replaces what Cronk holds, links included.
 */

export const TranscriptRole = Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("system")]);

/** A part of an entry that may be cut at 20 KB. */
export const CutPart = Type.Union([Type.Literal("text"), Type.Literal("toolInput"), Type.Literal("toolResult")]);
export type CutPart = Static<typeof CutPart>;

export const TranscriptEntry = Type.Object({
  position: Type.Integer({ minimum: 1, description: "Its place in the conversation, from 1." }),
  role: TranscriptRole,
  text: Type.Union([Type.String(), Type.Null()], { description: "A message's text; null for a tool call." }),
  toolName: Type.Union([Type.String(), Type.Null()], { description: "The tool called, for a tool call." }),
  toolInput: Type.Unknown({
    description:
      "What the tool was called with, as the agent gave it; null for a message. One whose JSON was over 20 KB is cut: " +
      "a string of its JSON's first 20 KB, with `toolInput` in `cutParts`.",
  }),
  toolResult: Type.Union([Type.String(), Type.Null()], { description: "What the tool answered, if it did." }),
  cut: Type.Boolean({ description: "Whether any part of it was cut at 20 KB, keeping only the start; `cutParts` says which." }),
  cutParts: Type.Array(CutPart, {
    description:
      "Which parts were cut at 20 KB, keeping only the start: a tool call's input (`toolInput`, as its JSON) and its " +
      "result (`toolResult`), or, for the last entry of a Transcript past 50 MB that was over 25 MB alone, a " +
      "message's text (`text`). Empty when nothing was.",
  }),
  at: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
});
export type TranscriptEntry = Static<typeof TranscriptEntry>;

export const Transcript = Type.Object({
  id: Type.String({ format: "uuid" }),
  slug: Type.String({
    description:
      "Its readable form, as its web address and the API take it in place of its id: its Agent's name, then its " +
      "short id. The name is only for reading; the short id finds it.",
  }),
  workspaceId: Type.String({ format: "uuid" }),
  sessionId: Type.String({ description: "The session it records, as its uploader named it." }),
  agent: Type.Object({ id: Type.String({ format: "uuid" }), name: Type.String() }),
  runId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
    description: "The Run whose Runner returned this session when starting it; null for a session of no Run.",
  }),
  tickets: Type.Array(
    Type.Object({ id: Type.String({ format: "uuid" }), key: Type.String(), title: Type.String() }),
    {
      description:
        "For a session of no Run, the Tickets its Cronk tool calls (`mcp__cronk__…`) name, in the order they first " +
        "named them; it shows in their timelines. Empty for a Run's Transcript, which shows with its Run.",
    },
  ),
  entryCount: Type.Integer({ minimum: 0, description: "How many entries it keeps." }),
  gap: Type.Union(
    [
      Type.Object({
        after: Type.Integer({ minimum: 0, description: "The position of the last entry kept before the gap." }),
        entries: Type.Integer({ minimum: 1, description: "How many entries were left out." }),
        bytes: Type.Integer({ minimum: 1, description: "How large they were." }),
      }),
      Type.Null(),
    ],
    {
      description:
        "Where entries were left out of a Transcript past 50 MB, which keeps its start and its end; null when nothing was.",
    },
  ),
  uploadedAt: Type.String({ format: "date-time", description: "When it was last uploaded." }),
});
export type Transcript = Static<typeof Transcript>;

/** A Transcript as a Ticket it names lists it, placed in the Ticket's timeline when its calls first named it. */
export const TicketTranscript = Type.Intersect([
  Transcript,
  Type.Object({
    namedAt: Type.String({
      format: "date-time",
      description: "When its first Cronk tool call naming this Ticket was made, or its upload's time if unknown.",
    }),
  }),
]);
export type TicketTranscript = Static<typeof TicketTranscript>;

export const EntryPage = Type.Object({
  entries: Type.Array(TranscriptEntry),
  next: Type.Union([Type.Integer(), Type.Null()], { description: "The `after` for the next page; null on the last." }),
});
export type EntryPage = Static<typeof EntryPage>;

/** An entry as a converter produces it, before scrubbing and the caps. */
export type ConvertedEntry = Omit<TranscriptEntry, "position" | "cut" | "cutParts">;

/**
 * An entry as stored: placed, scrubbed and with its tool input and result cut to 20 KB. `cut` says whether its tool
 * result, or a message's text, was cut; `toolInputCut` whether its tool input was.
 */
type StoredEntry = ConvertedEntry & { position: number; cut: boolean; toolInputCut: boolean };

/**
 * A tool call's input (as JSON) or result longer than this is cut to it, as is the text of a last entry too large for a
 * capped Transcript's end.
 */
const cutLimitBytes = 20 * 1024;
/** A Transcript larger than this keeps only its start and its end, each up to half of it. */
const transcriptLimitBytes = 50 * megabyte;

/** How many entries go into one insert. */
const insertBatch = 500;

type Row = Omit<Transcript, "uploadedAt"> & { uploadedAt: Date };
const columns = `transcripts.id, ${slugColumn("transcript", "transcripts.id", "agents.name")} as slug,
  transcripts.workspace_id as "workspaceId", transcripts.session_id as "sessionId",
  json_build_object('id', agents.id, 'name', agents.name) as agent, transcripts.run_id as "runId",
  coalesce((select json_agg(json_build_object('id', tickets.id, 'key', projects.key || '-' || tickets.number,
      'title', tickets.title) order by transcript_tickets.position)
    from transcript_tickets join tickets on tickets.id = transcript_tickets.ticket_id
    join projects on projects.id = tickets.project_id
    where transcript_tickets.transcript_id = transcripts.id), '[]') as tickets,
  (select count(*)::int from transcript_entries where transcript_id = transcripts.id) as "entryCount",
  case when transcripts.gap_after is null then null else json_build_object('after', transcripts.gap_after,
    'entries', transcripts.gap_entries, 'bytes', transcripts.gap_bytes) end as gap,
  transcripts.uploaded_at as "uploadedAt"`;
const present = ({ uploadedAt, ...row }: Row): Transcript => ({ ...row, uploadedAt: uploadedAt.toISOString() });

export const transcriptNotFound = () => new ApiError(404, "not_found", "No such Transcript.");

async function transcriptRow(db: Context["db"] | Tx, where: string, params: unknown[]): Promise<Row | undefined> {
  const { rows } = await db.query<Row>(
    `select ${columns} from transcripts join agents on agents.id = transcripts.agent_id where ${where}`,
    params,
  );
  return rows[0];
}

/**
 * Stores the Agent's upload of a session's transcript, converted into entries, in place of what Cronk held for
 * that session. Says whether the session's Transcript is new.
 */
export async function uploadTranscript(
  context: Context,
  agent: AgentCaller,
  sessionId: string,
  converted: ConvertedEntry[],
): Promise<{ transcript: Transcript; created: boolean }> {
  const now = context.clock.now();
  const { kept: entries, gap } = keepStartAndEnd(converted.map(scrub).map(cutToolParts));
  return transaction(context.db, async (tx) => {
    // The Run whose Runner returned this session when starting it, as one of this Agent's Runs.
    const run = await tx.query<{ id: string }>(
      "select id from runs where agent_id = $1 and session_id = $2 order by seq desc limit 1",
      [agent.id, sessionId],
    );
    const held = await tx.query<{ deleted: boolean; runId: string | null }>(
      `select deleted_at is not null as deleted, run_id as "runId" from transcripts
       where agent_id = $1 and session_id = $2 for update`,
      [agent.id, sessionId],
    );
    if (held.rows[0]?.deleted) {
      throw new ApiError(410, "transcript_deleted", "A User deleted this session's Transcript, so Cronk keeps no more of it.", {
        rule: "A deleted Transcript stays deleted, so an upload after it can't bring back a secret it was deleted for.",
        advice: "Nothing to do: later turns of this session aren't recorded.",
      });
    }
    const { rows } = await tx.query<{ id: string; created: boolean }>(
      `insert into transcripts (workspace_id, agent_id, session_id, uploaded_at, gap_after, gap_entries, gap_bytes, run_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (agent_id, session_id) do update set uploaded_at = excluded.uploaded_at, run_id = excluded.run_id,
         gap_after = excluded.gap_after, gap_entries = excluded.gap_entries, gap_bytes = excluded.gap_bytes
       returning id, (xmax = 0) as created`,
      [
        agent.workspace.id,
        agent.id,
        sessionId,
        now,
        gap?.after ?? null,
        gap?.entries ?? null,
        gap?.bytes ?? null,
        run.rows[0]?.id ?? null,
      ],
    );
    const { id, created } = rows[0]!;
    const unlinked = await tx.query<{ ticketId: string; namedAt: Date }>(
      `delete from transcript_tickets where transcript_id = $1 returning ticket_id as "ticketId", named_at as "namedAt"`,
      [id],
    );
    const namedBefore = new Map(unlinked.rows.map(({ ticketId, namedAt }) => [ticketId, namedAt]));
    const linked = run.rows[0] ? [] : await linkNamedTickets(tx, agent.workspace.id, id, converted, namedBefore, now);
    // Each Ticket that gained or lost the Transcript, or whose link moved, shows it differently in its timeline.
    const touched = await tx.query<{ id: string; projectId: string }>(
      `select id, project_id as "projectId" from tickets where id = any($1::uuid[]) order by id`,
      [[...new Set([...namedBefore.keys(), ...linked])]],
    );
    for (const ticket of touched.rows) {
      context.live.publish(tx, agent.workspace.id, { type: "transcripts.changed", projectId: ticket.projectId, ticketId: ticket.id });
    }
    await tx.query("delete from transcript_entries where transcript_id = $1", [id]);
    await insertEntries(tx, id, entries);
    const transcript = present((await transcriptRow(tx, "transcripts.id = $1", [id]))!);
    // A Run that gains its Transcript links it on its Ticket's timeline.
    if (transcript.runId && transcript.runId !== held.rows[0]?.runId) await runTicketChanged(context, tx, transcript.runId);
    await transcriptChanged(context, tx, agent.workspace.id, transcript);
    return { transcript, created };
  });
}

/** Inserts entries, a batch at a time, each with its size and the id its source gave its tool call, if any. */
async function insertEntries(tx: Tx, transcriptId: string, entries: (StoredEntry & { callId?: string | null })[]): Promise<void> {
  for (let start = 0; start < entries.length; start += insertBatch) {
    const batch = entries.slice(start, start + insertBatch);
    await tx.query(
      `insert into transcript_entries (transcript_id, position, role, text, tool_name, tool_input, tool_result, cut, at,
         bytes, call_id, tool_input_cut)
       select $1, * from unnest($2::int[], $3::transcript_role[], $4::text[], $5::text[], $6::jsonb[], $7::text[],
         $8::boolean[], $9::timestamptz[], $10::bigint[], $11::text[], $12::boolean[])`,
      [
        transcriptId,
        batch.map((entry) => entry.position),
        batch.map((entry) => entry.role),
        batch.map((entry) => entry.text),
        batch.map((entry) => entry.toolName),
        batch.map(toolInputJson),
        batch.map((entry) => entry.toolResult),
        batch.map((entry) => entry.cut),
        batch.map((entry) => entry.at),
        batch.map(sizeOf),
        batch.map((entry) => entry.callId ?? null),
        batch.map((entry) => entry.toolInputCut),
      ],
    );
  }
}

/**
 * What a source fetched a part at a time adds to a Transcript: its new entries, each tool call with the id its source
 * gave it, and the results of calls an earlier part brought, by those ids.
 */
export interface AppendedEntries {
  entries: (ConvertedEntry & { callId: string | null })[];
  results: { callId: string; toolResult: string }[];
}

/** The Run and session a Transcript filled a part at a time records, and the Agent it belongs to. */
export interface RunSession {
  workspaceId: string;
  agentId: string;
  runId: string;
  sessionId: string;
}

/**
 * Appends to the Transcript of a Run's session what its source added since the last part, scrubbed and capped as any
 * upload: new entries after those it holds, and results to the calls they answer, unless a cap left those out. Past
 * 50 MB it keeps its start and its end, widening the gap as the end moves on. Makes the Transcript, empty, if the
 * session has none yet; one a User deleted stays deleted. Says whether the Transcript changed.
 */
export async function appendTranscript(context: Context, tx: Tx, session: RunSession, appended: AppendedEntries): Promise<boolean> {
  const now = context.clock.now();
  // Made here unless the session has one: one made meanwhile by another transaction is waited for and appended to.
  const made = await tx.query(
    `insert into transcripts (workspace_id, agent_id, session_id, uploaded_at, run_id) values ($1, $2, $3, $4, $5)
     on conflict (agent_id, session_id) do nothing`,
    [session.workspaceId, session.agentId, session.sessionId, now, session.runId],
  );
  const created = made.rowCount === 1;
  const held = await tx.query<{ id: string; deleted: boolean; gapAfter: number | null; gapEntries: number | null; gapBytes: string | null }>(
    `select id, deleted_at is not null as deleted, gap_after as "gapAfter", gap_entries as "gapEntries", gap_bytes as "gapBytes"
     from transcripts where agent_id = $1 and session_id = $2 for update`,
    [session.agentId, session.sessionId],
  );
  const transcript = held.rows[0]!;
  if (transcript.deleted) return false;
  const id = transcript.id;
  if (!created && appended.entries.length === 0 && appended.results.length === 0) return false;
  const gap =
    transcript.gapAfter === null
      ? null
      : { after: transcript.gapAfter, entries: transcript.gapEntries!, bytes: Number(transcript.gapBytes) };

  // Positions go on from the last entry seen, kept or left out.
  const { rows: last } = await tx.query<{ last: number }>(
    "select coalesce(max(position), 0) as last from transcript_entries where transcript_id = $1",
    [id],
  );
  const after = Math.max(last[0]!.last, gap ? gap.after + gap.entries : 0);
  const entries = appended.entries.map(scrub).map((entry, index) => {
    const prepared = cutToolParts(entry, index);
    return { ...prepared, position: after + prepared.position };
  });
  await insertEntries(tx, id, entries);
  const results = appended.results.map(({ callId, toolResult }) => ({
    callId,
    ...cutToolParts(scrub({ role: "assistant", text: null, toolName: null, toolInput: null, toolResult, at: null }), 0),
  }));
  if (results.length > 0) {
    await tx.query(
      `update transcript_entries set tool_result = answered.result, cut = answered.cut, bytes = transcript_entries.bytes + answered.bytes
       from unnest($2::text[], $3::text[], $4::boolean[], $5::bigint[]) as answered (call_id, result, cut, bytes)
       where transcript_entries.transcript_id = $1 and transcript_entries.call_id = answered.call_id
         and transcript_entries.tool_result is null`,
      [
        id,
        results.map((result) => result.callId),
        results.map((result) => result.toolResult),
        results.map((result) => result.cut),
        results.map((result) => Buffer.byteLength(result.toolResult ?? "")),
      ],
    );
  }
  const capped = await capKeptEntries(tx, id, gap);
  await tx.query("update transcripts set uploaded_at = $2, gap_after = $3, gap_entries = $4, gap_bytes = $5 where id = $1", [
    id,
    now,
    capped?.after ?? null,
    capped?.entries ?? null,
    capped?.bytes ?? null,
  ]);
  // A Run that gains its Transcript links it on its Ticket's timeline.
  if (created) await runTicketChanged(context, tx, session.runId);
  await transcriptChanged(context, tx, session.workspaceId, { id, runId: session.runId });
  return true;
}

/**
 * Keeps a Transcript's stored entries within 50 MB as an upload's are: past it, its start (up to half, or what a
 * gap already left before it) and as much of its end as fits in the other half, widening the gap between; a last
 * entry too large for the end alone first has its text cut to 20 KB. Results added to calls in its start since make
 * the end's share smaller, so the whole stays within 50 MB. Returns the gap.
 */
async function capKeptEntries(tx: Tx, transcriptId: string, gap: Gap | null): Promise<Gap | null> {
  const total = async () => {
    const { rows } = await tx.query<{ total: number }>(
      "select coalesce(sum(bytes), 0)::float8 as total from transcript_entries where transcript_id = $1",
      [transcriptId],
    );
    return rows[0]!.total;
  };
  if ((await total()) <= transcriptLimitBytes) return gap;
  const half = transcriptLimitBytes / 2;
  const { rows: last } = await tx.query<{ position: number; text: string | null; bytes: number }>(
    `select position, text, bytes::float8 as bytes from transcript_entries where transcript_id = $1
     order by position desc limit 1`,
    [transcriptId],
  );
  if (last[0] && last[0].bytes > half && last[0].text !== null) {
    const text = cutToLimit(last[0].text);
    await tx.query(
      `update transcript_entries set text = $3, cut = true, bytes = bytes - $4 where transcript_id = $1 and position = $2`,
      [transcriptId, last[0].position, text, Buffer.byteLength(last[0].text) - Buffer.byteLength(text)],
    );
    if ((await total()) <= transcriptLimitBytes) return gap;
  }
  let headLast = gap?.after;
  if (headLast === undefined) {
    const head = await tx.query<{ last: number }>(
      `select coalesce(max(position), 0) as last from (select position, sum(bytes) over (order by position) as upto
         from transcript_entries where transcript_id = $1) as sized where upto <= $2`,
      [transcriptId, half],
    );
    headLast = head.rows[0]!.last;
  }
  const { rows: head } = await tx.query<{ bytes: number }>(
    "select coalesce(sum(bytes), 0)::float8 as bytes from transcript_entries where transcript_id = $1 and position <= $2",
    [transcriptId, headLast],
  );
  const endShare = Math.max(0, Math.min(half, transcriptLimitBytes - head[0]!.bytes));
  const { rows: left } = await tx.query<{ entries: number; bytes: number }>(
    `with tail as (select position, sum(bytes) over (order by position desc) as from_end
       from transcript_entries where transcript_id = $1 and position > $2),
     dropped as (delete from transcript_entries using tail where transcript_entries.transcript_id = $1
       and transcript_entries.position = tail.position and tail.from_end > $3 returning transcript_entries.bytes)
     select count(*)::int as entries, coalesce(sum(bytes), 0)::float8 as bytes from dropped`,
    [transcriptId, headLast, endShare],
  );
  return { after: headLast, entries: (gap?.entries ?? 0) + left[0]!.entries, bytes: (gap?.bytes ?? 0) + left[0]!.bytes };
}

/** The tool calls to Cronk's own MCP server, as Claude Code names them when the server is added as `cronk`. */
const cronkTool = /^mcp__cronk__/i;
/** The inputs of Cronk's tools that name a Ticket, by its key or its id. */
const ticketInputs = ["ticket", "blocks"];

/**
 * Links the Transcript to each Ticket of the Workspace its Cronk tool calls name, in the order they first named
 * them, each placed at the time of the first call naming it: when the transcript gives that call no time, where
 * the upload before placed it, or else now. Every entry counts, even one a cap left out. Says which it linked.
 */
async function linkNamedTickets(
  tx: Tx,
  workspaceId: string,
  transcriptId: string,
  entries: ConvertedEntry[],
  namedBefore: Map<string, Date>,
  now: Date,
): Promise<string[]> {
  // Each Ticket a call names, by its key or id as the call gave it.
  const named: { name: string; at: string | null }[] = [];
  for (const entry of entries) {
    if (entry.toolName === null || !cronkTool.test(entry.toolName)) continue;
    const input = entry.toolInput;
    if (typeof input !== "object" || input === null || Array.isArray(input)) continue;
    for (const field of ticketInputs) {
      const value = (input as Record<string, unknown>)[field];
      if (typeof value === "string") named.push({ name: value.trim(), at: entry.at });
    }
  }
  const ids = [...new Set(named.map(({ name }) => name.toLowerCase()).filter(isUuid))];
  const isKey = (name: string) => keysWritten(name)[0] === name;
  const keys = [...new Set(named.map(({ name }) => name).filter(isKey))];
  const byId = await tx.query<{ id: string }>("select id from tickets where workspace_id = $1 and id = any($2::uuid[])", [
    workspaceId,
    ids,
  ]);
  const byKey = await mentionsInEach(tx, workspaceId, keys);
  const ticketOf = new Map<string, string>([
    ...byId.rows.map(({ id }) => [id, id] as const),
    ...keys.flatMap((key, index) => byKey[index]!.map((mention) => [key, mention.ticketId] as const)),
  ]);
  const firstNamed = new Map<string, Date>();
  for (const { name, at } of named) {
    const ticketId = ticketOf.get(isUuid(name) ? name.toLowerCase() : name);
    if (ticketId && !firstNamed.has(ticketId)) firstNamed.set(ticketId, at ? new Date(at) : (namedBefore.get(ticketId) ?? now));
  }
  if (firstNamed.size === 0) return [];
  await tx.query(
    `insert into transcript_tickets (transcript_id, workspace_id, ticket_id, named_at, position)
     select $1, $2, ticket_id, named_at, position from unnest($3::uuid[], $4::timestamptz[]) with ordinality
       as named (ticket_id, named_at, position)`,
    [transcriptId, workspaceId, [...firstNamed.keys()], [...firstNamed.values()]],
  );
  return [...firstNamed.keys()];
}

/** The entry with every known secret in its text, tool input and tool result scrubbed. */
function scrub<Entry extends ConvertedEntry>(entry: Entry): Entry {
  return {
    ...entry,
    text: entry.text === null ? null : scrubText(entry.text),
    toolInput: scrubValue(entry.toolInput),
    toolResult: entry.toolResult === null ? null : scrubText(entry.toolResult),
  };
}

/**
 * The entry, placed, with its tool call's input and result each cut to its first 20 KB, never splitting a character,
 * and marked if they were. An input is cut as its JSON, which a cut leaves invalid, so it is kept as a JSON string of
 * that JSON's start.
 */
function cutToolParts<Entry extends ConvertedEntry>(entry: Entry, index: number): Entry & StoredEntry {
  const toolResult = entry.toolResult === null ? null : cutToLimit(entry.toolResult);
  const inputJson = toolInputJson(entry);
  const cutInput = inputJson === null ? null : cutToLimit(inputJson);
  const toolInputCut = cutInput !== inputJson;
  return {
    ...entry,
    position: index + 1,
    toolInput: toolInputCut ? cutInput : entry.toolInput,
    toolResult,
    cut: toolResult !== entry.toolResult,
    toolInputCut,
  };
}

/**
 * The entry with its text cut to its first 20 KB, as a tool result is, and marked if it was: what the end of a
 * Transcript past 50 MB keeps of its last entry when that alone is too large for the end.
 */
function cutText(entry: StoredEntry): StoredEntry {
  const text = entry.text === null ? null : cutToLimit(entry.text);
  if (text === null || text === entry.text) return entry;
  return { ...entry, text, cut: true };
}

/** The text's first 20 KB (the cut limit), never splitting a character; the text itself when it is no longer. */
function cutToLimit(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= cutLimitBytes) return text;
  let end = cutLimitBytes;
  // Back off a character's continuation bytes (10xxxxxx) so the cut falls between characters.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

/** A tool call's input as stored, in JSON; none for a message. */
const toolInputJson = (entry: Pick<ConvertedEntry, "toolName" | "toolInput">): string | null =>
  entry.toolName === null ? null : JSON.stringify(entry.toolInput ?? null);

/** How much an entry takes up: its text, tool name, tool input and tool result, in bytes. */
function sizeOf(entry: StoredEntry): number {
  return (
    Buffer.byteLength(entry.text ?? "") +
    Buffer.byteLength(entry.toolName ?? "") +
    Buffer.byteLength(toolInputJson(entry) ?? "") +
    Buffer.byteLength(entry.toolResult ?? "")
  );
}

interface Gap {
  after: number;
  entries: number;
  bytes: number;
}

/**
 * The entries a Transcript keeps: all of them up to 50 MB; past that, as many from its start and from its end as
 * fit in half of it each, with the gap left between them. A last entry too large for the end alone first has its
 * text cut to 20 KB, so the end still shows how the Transcript ended.
 */
function keepStartAndEnd(converted: StoredEntry[]): { kept: StoredEntry[]; gap: Gap | null } {
  const sum = (sizes: number[]) => sizes.reduce((total, size) => total + size, 0);
  if (sum(converted.map(sizeOf)) <= transcriptLimitBytes) return { kept: converted, gap: null };
  const half = transcriptLimitBytes / 2;
  const entries = sizeOf(converted.at(-1)!) > half ? [...converted.slice(0, -1), cutText(converted.at(-1)!)] : converted;
  const sizes = entries.map(sizeOf);
  if (sum(sizes) <= transcriptLimitBytes) return { kept: entries, gap: null };
  // The start keeps entries [0, headCount), the end entries [tailFrom, length); the gap is what lies between.
  let headCount = 0;
  for (let bytes = 0; headCount < entries.length && bytes + sizes[headCount]! <= half; headCount += 1) bytes += sizes[headCount]!;
  let tailFrom = entries.length;
  for (let bytes = 0; tailFrom > headCount && bytes + sizes[tailFrom - 1]! <= half; tailFrom -= 1) bytes += sizes[tailFrom - 1]!;
  const leftOut = sizes.slice(headCount, tailFrom);
  return {
    kept: [...entries.slice(0, headCount), ...entries.slice(tailFrom)],
    gap: { after: headCount, entries: leftOut.length, bytes: sum(leftOut) },
  };
}

export async function findTranscript({ db }: Context, viewer: Viewer, transcriptId: string): Promise<Transcript> {
  if (!isUuid(transcriptId)) throw transcriptNotFound();
  const view = inView(viewer, "transcripts.workspace_id", "$2");
  const row = await transcriptRow(db, `transcripts.id = $1 and transcripts.deleted_at is null and ${view.sql}`, [
    transcriptId,
    view.value,
  ]);
  if (!row) throw transcriptNotFound();
  return present(row);
}

/**
 * The Agent's own Transcripts, of its sessions that matched no Run, such as Claude Code connected by hand; the
 * last uploaded first. A Run's Transcript is listed with its Run instead.
 */
export async function agentTranscripts({ db }: Context, viewer: Viewer, agentId: string): Promise<Transcript[]> {
  const view = inView(viewer, "agents.workspace_id", "$2");
  const agent = isUuid(agentId)
    ? await db.query(`select 1 from agents where agents.id = $1 and ${view.sql}`, [agentId, view.value])
    : { rowCount: 0 };
  if (agent.rowCount === 0) throw new ApiError(404, "not_found", "No such Agent.");
  const { rows } = await db.query<Row>(
    `select ${columns} from transcripts join agents on agents.id = transcripts.agent_id
     where transcripts.agent_id = $1 and transcripts.run_id is null and transcripts.deleted_at is null
     order by transcripts.uploaded_at desc, transcripts.id`,
    [agentId],
  );
  return rows.map(present);
}

/** The Transcripts linked to a Ticket by the Cronk tool calls that named it, in the order they first named it. */
export async function ticketTranscripts({ db }: Context, viewer: Viewer, ticketId: string): Promise<TicketTranscript[]> {
  const ticket = await findTicketRow(db, viewer, ticketId);
  if (!ticket) throw ticketNotFound();
  const { rows } = await db.query<Row & { namedAt: Date }>(
    `select ${columns}, transcript_tickets.named_at as "namedAt"
     from transcript_tickets join transcripts on transcripts.id = transcript_tickets.transcript_id
     join agents on agents.id = transcripts.agent_id
     where transcript_tickets.ticket_id = $1
     order by transcript_tickets.named_at, transcripts.id`,
    [ticket.id],
  );
  return rows.map(({ namedAt, ...row }) => ({ ...present(row), namedAt: namedAt.toISOString() }));
}

/** A page of a Transcript's entries, in order, after the given position. */
export async function entriesOf(
  context: Context,
  viewer: Viewer,
  transcriptId: string,
  { after = 0, limit = 200 }: { after?: number; limit?: number },
): Promise<EntryPage> {
  const transcript = await findTranscript(context, viewer, transcriptId);
  const { rows } = await context.db.query<Omit<StoredEntry, "at"> & { at: Date | null }>(
    `select position, role, text, tool_name as "toolName", tool_input as "toolInput", tool_result as "toolResult", cut,
       tool_input_cut as "toolInputCut", at
     from transcript_entries where transcript_id = $1 and position > $2 order by position limit $3`,
    [transcript.id, after, limit + 1],
  );
  const more = rows.length > limit;
  const entries = rows.slice(0, limit).map(({ at, cut, toolInputCut, ...entry }) => {
    // `cut` stored says whether its text or its tool result was cut: an entry has one or the other.
    const cutParts: CutPart[] = [
      ...(cut && entry.text !== null ? (["text"] as const) : []),
      ...(toolInputCut ? (["toolInput"] as const) : []),
      ...(cut && entry.text === null ? (["toolResult"] as const) : []),
    ];
    return { ...entry, cut: cutParts.length > 0, cutParts, at: at?.toISOString() ?? null };
  });
  return { entries, next: more ? entries.at(-1)!.position : null };
}

/**
 * Deletes a Transcript's entries, for when the scrubbing missed a secret; only a User may. Its row stays behind,
 * marked deleted, so its Run says it was deleted and a later upload of its session is refused.
 */
export async function deleteTranscript(context: Context, actor: Caller, transcriptId: string): Promise<void> {
  const transcript = await findTranscript(context, actor, transcriptId);
  if (actor.kind === "agent") {
    throw new ApiError(403, "agent_not_allowed", `${actor.name} is an Agent, and only a User can delete a Transcript.`, {
      rule: "Only a User deletes a Transcript, so an agent can't remove the record of what it did.",
      advice: `Leave the Transcript as it is; ask ${ownerName(actor)}, ${actor.name}'s Owner, if it should go.`,
    });
  }
  await transaction(context.db, async (tx) => {
    const { rows } = await tx.query<{ workspaceId: string }>(
      `update transcripts set deleted_at = $2, deleted_by = $3 where id = $1 and deleted_at is null
       returning workspace_id as "workspaceId"`,
      [transcript.id, context.clock.now(), actor.id],
    );
    // Another User deleted it first.
    if (!rows[0]) throw transcriptNotFound();
    await tx.query("delete from transcript_entries where transcript_id = $1", [transcript.id]);
    const deleted: TranscriptDeleted = {
      runId: transcript.runId,
      step: null,
      sessionId: transcript.sessionId,
      agent: transcript.agent,
    };
    if (transcript.runId) {
      const ticket = await runTicketChanged(context, tx, transcript.runId);
      await recordTranscriptDeleted(context, tx, ticket, actor.id, { ...deleted, step: ticket.step });
    }
    await transcriptChanged(context, tx, rows[0].workspaceId, transcript);
    // A session outside a Run drops out of the Tickets it named, each recording that it was deleted.
    const unlinked = await tx.query<{ id: string; projectId: string; workspaceId: string }>(
      `with unlinked as (delete from transcript_tickets where transcript_id = $1 returning ticket_id)
       select tickets.id, tickets.project_id as "projectId", tickets.workspace_id as "workspaceId"
       from unlinked join tickets on tickets.id = unlinked.ticket_id order by tickets.id`,
      [transcript.id],
    );
    for (const ticket of unlinked.rows) {
      await recordTranscriptDeleted(context, tx, ticket, actor.id, deleted);
      context.live.publish(tx, ticket.workspaceId, { type: "transcripts.changed", projectId: ticket.projectId, ticketId: ticket.id });
    }
  });
}

/**
 * What a `transcriptDeleted` Change records: the deleted Transcript's Run and its Step's name (both null for a
 * session outside a Run), its session and its Agent.
 */
interface TranscriptDeleted {
  runId: string | null;
  step: string | null;
  sessionId: string;
  agent: { id: string; name: string };
}

/** Records on a Ticket that a User deleted a Transcript of its Run, or one that named it. */
async function recordTranscriptDeleted(
  context: Context,
  tx: Tx,
  ticket: { id: string; workspaceId: string },
  userId: string,
  deleted: TranscriptDeleted,
): Promise<void> {
  await recordChanges(tx, ticket, userId, context.clock.now(), [{ field: "transcriptDeleted", from: deleted, to: null }]);
}

interface RunTicket {
  id: string;
  projectId: string;
  workspaceId: string;
  /** The name of the Run's Step. */
  step: string;
}

async function runTicket(tx: Tx, runId: string): Promise<RunTicket> {
  const { rows } = await tx.query<RunTicket>(
    `select tickets.id, tickets.project_id as "projectId", tickets.workspace_id as "workspaceId",
       runs.status_name as step
     from runs join tickets on tickets.id = runs.ticket_id where runs.id = $1`,
    [runId],
  );
  return rows[0]!;
}

/** Tells the viewers of the Run's Ticket that it changed, as its Run's Transcript did. */
async function runTicketChanged(context: Context, tx: Tx, runId: string): Promise<RunTicket> {
  const ticket = await runTicket(tx, runId);
  context.live.publish(tx, ticket.workspaceId, { type: "ticket.changed", projectId: ticket.projectId, ticketId: ticket.id });
  return ticket;
}

/**
 * Tells the Workspace's streams that a Transcript changed, so an open Transcript page shows it: a Run's goes to the
 * readers of its Ticket's Project; a session outside a Run to its Agent's Owner and the Users who can read every
 * Ticket it names. Call it before a deletion unlinks those Tickets.
 */
async function transcriptChanged(
  { live }: Context,
  tx: Tx,
  workspaceId: string,
  transcript: Pick<Transcript, "id" | "runId">,
): Promise<void> {
  const event = { type: "transcript.changed", transcriptId: transcript.id, runId: transcript.runId } as const;
  if (transcript.runId) {
    const ticket = await runTicket(tx, transcript.runId);
    live.publish(tx, workspaceId, event, { readersOf: [ticket.projectId] });
    return;
  }
  const { rows } = await tx.query<{ ownerId: string; projectIds: string[] }>(
    `select agents.owner_id as "ownerId",
       array(select distinct tickets.project_id from transcript_tickets join tickets on tickets.id = transcript_tickets.ticket_id
             where transcript_tickets.transcript_id = transcripts.id) as "projectIds"
     from transcripts join agents on agents.id = transcripts.agent_id where transcripts.id = $1`,
    [transcript.id],
  );
  const { ownerId, projectIds } = rows[0]!;
  live.publish(tx, workspaceId, event, { readersOf: projectIds, users: [ownerId] });
}
