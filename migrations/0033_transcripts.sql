-- Transcripts (ADR 0006): the record of an agent's conversation, converted on arrival into entries, with known
-- secrets scrubbed first; no raw file is kept. Each belongs to the Agent that uploaded it, keyed by its source
-- session, and to the Run that ran in that session, if any. Uploading the same session again replaces its entries.
create table transcripts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id),
  agent_id uuid not null,
  run_id uuid references runs (id),
  session_id text not null,
  -- Where a Transcript past its size cap was cut: the entries left out sat after this position.
  gap_after integer,
  gap_entries integer,
  gap_bytes bigint,
  uploaded_at timestamptz not null,
  foreign key (agent_id, workspace_id) references agents (id, workspace_id),
  constraint transcripts_gap_whole check (num_nulls(gap_after, gap_entries, gap_bytes) in (0, 3))
);
-- One Transcript per session of an Agent.
create unique index transcripts_agent_session_key on transcripts (agent_id, session_id);
create index transcripts_run_id_idx on transcripts (run_id) where run_id is not null;

create type transcript_role as enum ('user', 'assistant', 'system');

create table transcript_entries (
  transcript_id uuid not null references transcripts (id) on delete cascade,
  position integer not null,
  role transcript_role not null,
  text text,
  tool_name text,
  tool_input jsonb,
  tool_result text,
  -- Whether the tool result was cut at its size cap.
  cut boolean not null default false,
  at timestamptz,
  primary key (transcript_id, position)
);
