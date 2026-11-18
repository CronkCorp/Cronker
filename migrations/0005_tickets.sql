-- Ticket keys are numbered in order per Project; the Project holds the next number.
alter table projects add column next_ticket_number integer not null default 1;

create type priority as enum ('urgent', 'high', 'medium', 'low', 'none');

-- Lets records inside a Status insist they carry the Status's own Project.
alter table statuses add constraint statuses_id_project_key unique (id, project_id);

create table tickets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id),
  project_id uuid not null,
  number integer not null,
  title text not null,
  description text not null default '',
  status_id uuid not null,
  priority priority not null default 'none',
  -- Free-form, kept as first written; never two that differ only in case.
  labels text[] not null default '{}',
  assignee_id uuid references users (id),
  due_date date,
  estimate numeric,
  created_by uuid not null references users (id),
  created_at timestamptz not null,
  foreign key (project_id, workspace_id) references projects (id, workspace_id),
  foreign key (status_id, project_id) references statuses (id, project_id),
  constraint tickets_project_number_key unique (project_id, number)
);
create index tickets_status_id_idx on tickets (status_id);
create index tickets_workspace_id_idx on tickets (workspace_id);

-- Lets records on a Ticket insist they carry the Ticket's own Workspace.
alter table tickets add constraint tickets_id_workspace_key unique (id, workspace_id);

-- Comments on a Ticket, each by an Actor; only Users so far. A reply is to a Comment on the same Ticket.
create table comments (
  id uuid primary key default gen_random_uuid(),
  -- Orders Comments made at the same instant in the order they were made.
  seq bigint generated always as identity,
  workspace_id uuid not null references workspaces (id),
  ticket_id uuid not null,
  reply_to_id uuid,
  actor_user_id uuid not null references users (id),
  body text not null,
  created_at timestamptz not null,
  foreign key (ticket_id, workspace_id) references tickets (id, workspace_id),
  constraint comments_id_ticket_key unique (id, ticket_id),
  foreign key (reply_to_id, ticket_id) references comments (id, ticket_id)
);
create index comments_ticket_id_idx on comments (ticket_id, seq);

-- Every Change to a Ticket: who made it, when, and the field's value before and after.
-- Statuses and Assignees are kept as they were named then, so renaming or removing them later
-- doesn't rewrite history.
create table changes (
  id uuid primary key default gen_random_uuid(),
  -- Orders Changes made at the same instant in the order they were made.
  seq bigint generated always as identity,
  workspace_id uuid not null references workspaces (id),
  ticket_id uuid not null,
  actor_user_id uuid not null references users (id),
  at timestamptz not null,
  field text not null,
  from_value jsonb,
  to_value jsonb,
  foreign key (ticket_id, workspace_id) references tickets (id, workspace_id)
);
create index changes_ticket_id_idx on changes (ticket_id, seq);
