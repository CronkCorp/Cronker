-- A Managed Agents Run's Transcript is filled from its session's events, fetched a few at a time: when someone opens it
-- while the Run runs, and once the Run ends. Each fetch appends what the session added since the last one.

-- How large an entry is (its text, tool name, tool input and tool result, in bytes), so an appended Transcript past
-- its size cap keeps its start and its end without reading its entries back. Earlier entries are measured here.
alter table transcript_entries add column bytes bigint not null default 0;
update transcript_entries set bytes = octet_length(coalesce(text, '')) + octet_length(coalesce(tool_name, ''))
  + coalesce(octet_length(tool_input::text), 0) + octet_length(coalesce(tool_result, ''));
-- A tool call's id in its source, so its result, arriving with a later fetch, finds it.
alter table transcript_entries add column call_id text;
create index transcript_entries_call_id_idx on transcript_entries (transcript_id, call_id) where call_id is not null;

-- Where the last fetch of a Run's session events got to: the page holding the last event it took (null for the first
-- page), and how many of that page's events it took. Events are only ever added, so a page read again starts the same.
-- Once the Run ended and its session's last events are in its Transcript, the fetch is done.
alter table managed_agent_runs add column events_page text;
alter table managed_agent_runs add column events_taken integer not null default 0;
alter table managed_agent_runs add column transcript_fetched_at timestamptz;
-- Runs that ended before Transcripts were fetched aren't fetched afterwards.
update managed_agent_runs set transcript_fetched_at = now()
  where run_id not in (select id from runs where state = 'running');
drop index managed_agent_runs_unfinished_idx;
create index managed_agent_runs_unfinished_idx on managed_agent_runs (run_id)
  where revoked_at is null or vault_deleted_at is null or archived_at is null or transcript_fetched_at is null;
