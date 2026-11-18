-- The Assignee a Ticket lost when they were removed from its Workspace. Set while the Ticket waits in
-- every Admin's Inbox to be reassigned; assigning the Ticket clears it.
alter table tickets add column former_assignee_id uuid references users (id);
create index tickets_former_assignee_idx on tickets (workspace_id) where former_assignee_id is not null;
