-- The Run that asked Cronk to merge each Pull Request, from just before Cronk asks GitHub until Cronk records the
-- merge or GitHub refuses it, so GitHub's own delivery of the merge, arriving first, records it as that Run's.
alter table pull_requests add column merge_asked_by_run_id uuid references runs (id) on delete set null;
