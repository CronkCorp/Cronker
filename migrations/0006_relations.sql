create type relation_kind as enum ('blocks', 'relates');

-- A Relation between two Tickets of one Workspace: `ticket_id` blocks `other_ticket_id`, or the two
-- relate to each other. Two Tickets have at most one Relation of each kind, whichever way it was made.
create table relations (
  id uuid primary key default gen_random_uuid(),
  -- Orders Relations made at the same instant in the order they were made.
  seq bigint generated always as identity,
  workspace_id uuid not null references workspaces (id),
  kind relation_kind not null,
  ticket_id uuid not null,
  other_ticket_id uuid not null,
  created_by uuid not null references users (id),
  created_at timestamptz not null,
  foreign key (ticket_id, workspace_id) references tickets (id, workspace_id),
  foreign key (other_ticket_id, workspace_id) references tickets (id, workspace_id),
  constraint relations_not_to_itself check (ticket_id <> other_ticket_id)
);
create unique index relations_pair_key on relations (kind, least(ticket_id, other_ticket_id), greatest(ticket_id, other_ticket_id));
create index relations_ticket_id_idx on relations (ticket_id);
create index relations_other_ticket_id_idx on relations (other_ticket_id);

-- A Sub-Ticket's parent is a Ticket of the same Project, never the Ticket itself.
alter table tickets add constraint tickets_id_project_key unique (id, project_id);
alter table tickets add column parent_id uuid;
alter table tickets add constraint tickets_parent_same_project
  foreign key (parent_id, project_id) references tickets (id, project_id);
alter table tickets add constraint tickets_not_own_parent check (parent_id <> id);
create index tickets_parent_id_idx on tickets (parent_id);
