-- Merge Queue 7 (CRONK-98): a head conflicting with its base branch steps aside, out of line, so the queue moves on.
-- `resolving-conflict` while a Run of the Merge Step resolves it; after its *resolved* Outcome, `waiting-for-checks`
-- until the resolving commit's checks are green, when it rejoins its queue at the front, as `queued` again. `aside`
-- is true from stepping aside until rejoining. `conflict_count` counts the times the entry stepped aside, which
-- isn't a round; past 3 its Ticket comes to its Assignee instead. The `conflict_*` columns hold what last set it
-- aside: the merge that caused the conflict, if Cronk knows it, the base commit and when.
alter table merge_queue drop constraint merge_queue_state_check;
alter table merge_queue add constraint merge_queue_state_check
  check (state in ('queued', 'merging', 'updating-branch', 'resolving-conflict', 'waiting-for-checks'));
alter table merge_queue add column aside boolean not null default false;
alter table merge_queue add column conflict_count integer not null default 0;
alter table merge_queue add column conflict_merged_pull_request_id bigint references pull_requests (id) on delete set null;
alter table merge_queue add column conflict_base_sha text;
alter table merge_queue add column conflict_at timestamptz;

-- The merge commit GitHub named answering a merge Cronk asked for, so a head conflicting with it can name the merge
-- before GitHub's delivery of it sets `merge_commit_sha`.
alter table pull_requests add column answered_merge_sha text;

-- Existing Merge Steps get the *resolved* Outcome, which leaves the Ticket in the Merge Status, last among their
-- Outcomes; their Briefs stay as each Project wrote them.
insert into outcomes (step_id, project_id, position, name, status_id, is_default, needs_you, counts_as_round)
select steps.id, steps.project_id, (select coalesce(max(position), -1) + 1 from outcomes o where o.step_id = steps.id),
  'resolved', steps.status_id, false, false, false
from steps
where steps.kind = 'merge'
  and not exists (select from outcomes o where o.step_id = steps.id and (o.status_id = steps.status_id or lower(o.name) = 'resolved'));
