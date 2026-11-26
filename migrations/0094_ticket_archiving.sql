-- A User archives a Ticket in a Done or Canceled Status (CRONK-175): it leaves the board, the default Ticket lists and
-- search, staying readable by its key. Null while it isn't archived; who archived it is a User or an Agent with a
-- Full token, as its Owner's act.
alter table tickets add column archived_at timestamptz;
alter table tickets add column archived_by uuid references users (id) on delete set null;
alter table tickets add column archived_by_agent uuid references agents (id) on delete set null;
