-- Projects, inside one Workspace. Keys and names are unique within it, ignoring case.
create table projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id),
  name text not null,
  key text not null,
  created_at timestamptz not null
);
create unique index projects_workspace_key_key on projects (workspace_id, lower(key));
create unique index projects_workspace_name_key on projects (workspace_id, lower(name));

-- A Project's Statuses, in board order. Every Project keeps at least one Status of each kind;
-- Cronk checks that on every change, under a lock on the Project's row.
create type status_kind as enum ('backlog', 'active', 'review', 'done', 'canceled');

create table statuses (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id),
  project_id uuid not null references projects (id),
  name text not null,
  kind status_kind not null,
  position integer not null,
  created_at timestamptz not null
);
create unique index statuses_project_name_key on statuses (project_id, lower(name));
create index statuses_project_id_idx on statuses (project_id, position);
