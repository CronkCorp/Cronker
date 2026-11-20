-- A Pull Request's base branch and, once merged, its merge commit, as the latest delivery about it reported them.
-- Pull Requests Cronk heard of before have neither until GitHub reports them again.
alter table pull_requests add column base_branch text;
alter table pull_requests add column merge_commit_sha text;
create index pull_requests_base_idx on pull_requests (repository_id, base_branch) where state in ('open', 'draft');

-- Open Pull Requests Cronk is to ask GitHub about, to learn whether they conflict with their base branch: after a
-- merge into that branch (`merged_pull_request_id`), or once an Outcome moved a Ticket they link into a Review
-- Status (the latest merge Cronk knows into the branch, if any). GitHub may answer that it is still working it out,
-- so a check is asked again at `due_at`, a bounded number of times (`tries`).
create table mergeability_checks (
  pull_request_id bigint primary key references pull_requests (id),
  merged_pull_request_id bigint references pull_requests (id),
  tries integer not null default 0,
  due_at timestamptz not null
);
create index mergeability_checks_due_at_idx on mergeability_checks (due_at);
