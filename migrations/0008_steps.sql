-- A Status's Step: the agent work it asks for. A Status has at most one; removing the Status removes it.
create table steps (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id),
  project_id uuid not null,
  status_id uuid not null,
  brief text not null,
  model text not null,
  round_limit integer not null default 2 check (round_limit >= 0),
  created_at timestamptz not null,
  foreign key (project_id, workspace_id) references projects (id, workspace_id),
  foreign key (status_id, project_id) references statuses (id, project_id) on delete cascade,
  constraint steps_status_key unique (status_id),
  constraint steps_id_project_key unique (id, project_id)
);

-- A Step's Outcomes, in order, each moving the Ticket to a Status of the same Project.
-- Cronk checks the rest on every change: exactly one default and one *needs you*, and
-- the kinds of Status each may target.
create table outcomes (
  step_id uuid not null,
  project_id uuid not null,
  position integer not null,
  name text not null,
  status_id uuid not null,
  is_default boolean not null,
  needs_you boolean not null,
  counts_as_round boolean not null,
  primary key (step_id, position),
  foreign key (step_id, project_id) references steps (id, project_id) on delete cascade,
  -- A Status an Outcome targets can't be removed until no Outcome targets it.
  foreign key (status_id, project_id) references statuses (id, project_id)
);
create unique index outcomes_step_name_key on outcomes (step_id, lower(name));
create index outcomes_status_id_idx on outcomes (status_id);
