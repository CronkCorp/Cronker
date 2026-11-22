-- Agent Access (CRONK-9): a Project's Agent Access dropping below Write undelegates its Tickets, and each waits in its
-- Assignee's Inbox from then until a User moves, reassigns or delegates it.
alter table tickets add column undelegated_at timestamptz;
create index tickets_undelegated_idx on tickets (workspace_id, assignee_id) where undelegated_at is not null;
