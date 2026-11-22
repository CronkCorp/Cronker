-- The Merge Queue (CRONK-94): each Pull Request a User queued by pressing Merge on its Ticket, waiting in the Merge
-- Status it entered for Cronk to merge it. A queue is the entries whose Pull Requests share a Repository and base
-- branch, read from `pull_requests`; its order is `seq`, the order entries joined, never set by hand. `state` is
-- `merging` while Cronk asks GitHub to merge it. Leaving `status_id` takes a Ticket's entries out.
create table merge_queue (
  pull_request_id bigint primary key references pull_requests (id) on delete cascade,
  ticket_id uuid not null references tickets (id) on delete cascade,
  status_id uuid not null references statuses (id) on delete cascade,
  queued_by_user_id uuid not null references users (id) on delete cascade,
  entered_at timestamptz not null,
  seq bigserial not null,
  state text not null default 'queued' check (state in ('queued', 'merging'))
);
create index merge_queue_ticket_idx on merge_queue (ticket_id);
