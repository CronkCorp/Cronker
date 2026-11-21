import { slugColumn, slugDescription } from "../http/readable.js";
import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { transaction, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
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
export type ConvertedEntry = Omit<TranscriptEntry, "position" | "cut">;

/** A tool result longer than this is cut to it. */
const toolResultLimitBytes = 20 * 1024;
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
  const { kept: entries, gap } = keepStartAndEnd(converted.map(scrub).map(cutToolResult));
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
          batch.map(toolInputJson),
          batch.map((entry) => entry.toolResult),
          batch.map((entry) => entry.cut),
          batch.map((entry) => entry.at),
        ],
      );
    }
    const transcript = present((await transcriptRow(tx, "transcripts.id = $1", [id]))!);
    // A Run that gains its Transcript links it on its Ticket's timeline.
    if (transcript.runId && transcript.runId !== held.rows[0]?.runId) await runTicketChanged(context, tx, transcript.runId);
    transcriptChanged(context, tx, agent.workspace.id, transcript);
    return { transcript, created };
  });
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

/** A tool call's input as stored, in JSON; none for a message. */
const toolInputJson = (entry: TranscriptEntry): string | null =>
  entry.toolName === null ? null : JSON.stringify(entry.toolInput ?? null);

/** How much an entry takes up: its text, tool name, tool input and tool result, in bytes. */
function sizeOf(entry: TranscriptEntry): number {
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
 * fit in half of it each, with the gap left between them.
 */
function keepStartAndEnd(entries: TranscriptEntry[]): { kept: TranscriptEntry[]; gap: Gap | null } {
  const sizes = entries.map(sizeOf);
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= transcriptLimitBytes) return { kept: entries, gap: null };
  const half = transcriptLimitBytes / 2;
  // The start keeps entries [0, headCount), the end entries [tailFrom, length); the gap is what lies between.
  let headCount = 0;
  for (let bytes = 0; headCount < entries.length && bytes + sizes[headCount]! <= half; headCount += 1) bytes += sizes[headCount]!;
  let tailFrom = entries.length;
  for (let bytes = 0; tailFrom > headCount && bytes + sizes[tailFrom - 1]! <= half; tailFrom -= 1) bytes += sizes[tailFrom - 1]!;
  const leftOut = sizes.slice(headCount, tailFrom);
  return {
    kept: [...entries.slice(0, headCount), ...entries.slice(tailFrom)],
    gap: { after: headCount, entries: leftOut.length, bytes: leftOut.reduce((sum, size) => sum + size, 0) },
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
  const { rows } = await context.db.query<Omit<TranscriptEntry, "at"> & { at: Date | null }>(
    `select position, role, text, tool_name as "toolName", tool_input as "toolInput", tool_result as "toolResult", cut, at
     from transcript_entries where transcript_id = $1 and position > $2 order by position limit $3`,
    [transcript.id, after, limit + 1],
  );
  const more = rows.length > limit;
  const entries = rows.slice(0, limit).map(({ at, ...entry }) => ({ ...entry, at: at?.toISOString() ?? null }));
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
    transcriptChanged(context, tx, rows[0].workspaceId, transcript);
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

/** Tells the Workspace's streams that a Transcript changed, so an open Transcript page shows it. */
function transcriptChanged({ live }: Context, tx: Tx, workspaceId: string, transcript: Pick<Transcript, "id" | "runId">): void {
  live.publish(tx, workspaceId, { type: "transcript.changed", transcriptId: transcript.id, runId: transcript.runId });
}
