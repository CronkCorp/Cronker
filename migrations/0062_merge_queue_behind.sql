-- Merge Queue 5 (CRONK-96): a head behind its base branch is brought up to date before it merges. `updating-branch`
-- while Cronk asks GitHub to update its branch, then `waiting-for-checks` until the new commit's checks are green.
-- `updated_from_sha` is the head commit Cronk asked GitHub to update from, so the pass waits until GitHub reports the
-- new one rather than judging the old commit's checks.
alter table merge_queue drop constraint merge_queue_state_check;
alter table merge_queue add constraint merge_queue_state_check
  check (state in ('queued', 'merging', 'updating-branch', 'waiting-for-checks'));
alter table merge_queue add column updated_from_sha text;
