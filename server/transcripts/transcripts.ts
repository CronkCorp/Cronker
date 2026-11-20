import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { transaction, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import type { AgentCaller } from "../identity/callers.js";
import { inView, type Viewer } from "../identity/viewers.js";
import { megabyte } from "../config.js";
import { scrubText, scrubValue } from "./scrubbing.js";

/**
 * Transcripts (ADR 0006): the record of an agent's conversation, converted on arrival from its source's format
 * into one list of entries and stored in Postgres; no raw file is kept. A Transcript belongs to the Agent that
 * uploaded it, keyed by its source session, and to the Run that ran in that session, if any. Uploading the same
 * session again replaces what Cronk holds.
 */

export const TranscriptRole = Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("system")]);

export const TranscriptEntry = Type.Object({
  position: Type.Integer({ minimum: 1, description: "Its place in the conversation, from 1." }),
  role: TranscriptRole,
  text: Type.Union([Type.String(), Type.Null()], { description: "A message's text; null for a tool call." }),
  toolName: Type.Union([Type.String(), Type.Null()], { description: "The tool called, for a tool call." }),
  toolInput: Type.Unknown({ description: "What the tool was called with, as the agent gave it; null for a message." }),
  toolResult: Type.Union([Type.String(), Type.Null()], { description: "What the tool answered, if it did." }),
  cut: Type.Boolean({ description: "Whether the tool result was cut at 20 KB; only its start is kept." }),
  at: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
});
export type TranscriptEntry = Static<typeof TranscriptEntry>;

export const Transcript = Type.Object({
  id: Type.String({ format: "uuid" }),
  sessionId: Type.String({ description: "The session it records, as its uploader named it." }),
  agent: Type.Object({ id: Type.String({ format: "uuid" }), name: Type.String() }),
  runId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
    description: "The Run whose Runner returned this session when starting it; null for a session of no Run.",
  }),
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

export const EntryPage = Type.Object({
  entries: Type.Array(TranscriptEntry),
  next: Type.Union([Type.Integer(), Type.Null()], { description: "The `after` for the next page; null on the last." }),
});
export type EntryPage = Static<typeof EntryPage>;

/** An entry as a converter produces it, before scrubbing and the caps. */
export type ConvertedEntry = Omit<TranscriptEntry, "position" | "cut">;

/** A tool result longer than this is cut to it. */
const toolResultLimitBytes = 20 * 1024;
/** A Transcript larger than this keeps only its start and its end, each up to half of it. */
const transcriptLimitBytes = 50 * megabyte;

/** How many entries go into one insert. */
const insertBatch = 500;

type Row = Omit<Transcript, "uploadedAt"> & { uploadedAt: Date };
const columns = `transcripts.id, transcripts.session_id as "sessionId",
  json_build_object('id', agents.id, 'name', agents.name) as agent, transcripts.run_id as "runId",
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
  const { kept: entries, gap } = keepStartAndEnd(converted.map(scrub).map(cutToolResult));
  return transaction(context.db, async (tx) => {
    // The Run whose Runner returned this session when starting it, as one of this Agent's Runs.
    const run = await tx.query<{ id: string }>(
      "select id from runs where agent_id = $1 and session_id = $2 order by seq desc limit 1",
      [agent.id, sessionId],
    );
    const { rows } = await tx.query<{ id: string; created: boolean }>(
      `insert into transcripts (workspace_id, agent_id, session_id, uploaded_at, gap_after, gap_entries, gap_bytes, run_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (agent_id, session_id) do update set uploaded_at = excluded.uploaded_at, run_id = excluded.run_id,
         gap_after = excluded.gap_after, gap_entries = excluded.gap_entries, gap_bytes = excluded.gap_bytes
       returning id, (xmax = 0) as created`,
      [agent.workspace.id, agent.id, sessionId, now, gap?.after ?? null, gap?.entries ?? null, gap?.bytes ?? null, run.rows[0]?.id ?? null],
    );
    const { id, created } = rows[0]!;
    await tx.query("delete from transcript_entries where transcript_id = $1", [id]);
    for (let start = 0; start < entries.length; start += insertBatch) {
      const batch = entries.slice(start, start + insertBatch);
      await tx.query(
        `insert into transcript_entries (transcript_id, position, role, text, tool_name, tool_input, tool_result, cut, at)
         select $1, * from unnest($2::int[], $3::transcript_role[], $4::text[], $5::text[], $6::jsonb[], $7::text[],
           $8::boolean[], $9::timestamptz[])`,
        [
          id,
          batch.map((entry) => entry.position),
          batch.map((entry) => entry.role),
          batch.map((entry) => entry.text),
          batch.map((entry) => entry.toolName),
          batch.map((entry) => (entry.toolName === null ? null : JSON.stringify(entry.toolInput ?? null))),
          batch.map((entry) => entry.toolResult),
          batch.map((entry) => entry.cut),
          batch.map((entry) => entry.at),
        ],
      );
    }
    return { transcript: present((await transcriptRow(tx, "transcripts.id = $1", [id]))!), created };
  });
}

/** The entry with every known secret in its text, tool input and tool result scrubbed. */
function scrub(entry: ConvertedEntry): ConvertedEntry {
  return {
    ...entry,
    text: entry.text === null ? null : scrubText(entry.text),
    toolInput: scrubValue(entry.toolInput),
    toolResult: entry.toolResult === null ? null : scrubText(entry.toolResult),
  };
}

/** The entry with its tool result cut to its first 20 KB, never splitting a character, and marked if it was. */
function cutToolResult(entry: ConvertedEntry, index: number): TranscriptEntry {
  const positioned = { ...entry, position: index + 1, cut: false };
  if (entry.toolResult === null) return positioned;
  const bytes = Buffer.from(entry.toolResult, "utf8");
  if (bytes.length <= toolResultLimitBytes) return positioned;
  let end = toolResultLimitBytes;
  // Back off a character's continuation bytes (10xxxxxx) so the cut falls between characters.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return { ...positioned, toolResult: bytes.subarray(0, end).toString("utf8"), cut: true };
}

/** How much an entry takes up: its text, tool name, tool input and tool result, in bytes. */
function sizeOf(entry: TranscriptEntry): number {
  return (
    Buffer.byteLength(entry.text ?? "") +
    Buffer.byteLength(entry.toolName ?? "") +
    (entry.toolName === null ? 0 : Buffer.byteLength(JSON.stringify(entry.toolInput ?? null))) +
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
 * fit in half of it each, with the gap left between them.
 */
function keepStartAndEnd(entries: TranscriptEntry[]): { kept: TranscriptEntry[]; gap: Gap | null } {
  const sizes = entries.map(sizeOf);
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= transcriptLimitBytes) return { kept: entries, gap: null };
  const half = transcriptLimitBytes / 2;
  let startEnd = 0;
  for (let bytes = 0; startEnd < entries.length && bytes + sizes[startEnd]! <= half; startEnd += 1) bytes += sizes[startEnd]!;
  let endStart = entries.length;
  for (let bytes = 0; endStart > startEnd && bytes + sizes[endStart - 1]! <= half; endStart -= 1) bytes += sizes[endStart - 1]!;
  const leftOut = sizes.slice(startEnd, endStart);
  return {
    kept: [...entries.slice(0, startEnd), ...entries.slice(endStart)],
    gap: { after: startEnd, entries: leftOut.length, bytes: leftOut.reduce((sum, size) => sum + size, 0) },
  };
}

export async function findTranscript({ db }: Context, viewer: Viewer, transcriptId: string): Promise<Transcript> {
  if (!isUuid(transcriptId)) throw transcriptNotFound();
  const view = inView(viewer, "transcripts.workspace_id", "$2");
  const row = await transcriptRow(db, `transcripts.id = $1 and ${view.sql}`, [transcriptId, view.value]);
  if (!row) throw transcriptNotFound();
  return present(row);
}

/** A page of a Transcript's entries, in order, after the given position. */
export async function entriesOf(
  context: Context,
  viewer: Viewer,
  transcriptId: string,
  { after = 0, limit = 200 }: { after?: number; limit?: number },
): Promise<EntryPage> {
  const transcript = await findTranscript(context, viewer, transcriptId);
  const { rows } = await context.db.query<Omit<TranscriptEntry, "at"> & { at: Date | null }>(
    `select position, role, text, tool_name as "toolName", tool_input as "toolInput", tool_result as "toolResult", cut, at
     from transcript_entries where transcript_id = $1 and position > $2 order by position limit $3`,
    [transcript.id, after, limit + 1],
  );
  const more = rows.length > limit;
  const entries = rows.slice(0, limit).map(({ at, ...entry }) => ({ ...entry, at: at?.toISOString() ?? null }));
  return { entries, next: more ? entries.at(-1)!.position : null };
}
