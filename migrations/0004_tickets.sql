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
