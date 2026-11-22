-- A conflict with its base branch marks the Pull Request instead of sending its Tickets back (CRONK-93): the base
-- branch and commit GitHub last said it conflicts with, the merge that made it conflict if Cronk knows it, and when
-- Cronk learned it. All null while GitHub last said it merges cleanly, or hasn't been asked.
alter table pull_requests add column conflict_branch text;
alter table pull_requests add column conflict_sha text;
alter table pull_requests add column conflict_merged_pull_request_id bigint references pull_requests (id);
alter table pull_requests add column conflict_at timestamptz;
