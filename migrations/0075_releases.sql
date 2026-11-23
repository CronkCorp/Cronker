-- Releases (CRONK-114): a Project's named sets of Tickets that ship together, such as `v0.3.0`. A Release goes from
-- planned to cut to released; only planned is reachable so far, and only a planned Release is renamed or deleted.
-- Its name is a semantic version, unique in its Project ignoring case. A Ticket has at most one Release, of its own
-- Project.
create type release_state as enum ('planned', 'cut', 'released');

create table releases (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id),
  project_id uuid not null,
  name text not null,
  state release_state not null default 'planned',
  created_at timestamptz not null,
  foreign key (project_id, workspace_id) references projects (id, workspace_id) on delete cascade,
  constraint releases_id_project_key unique (id, project_id)
);
create unique index releases_project_name_key on releases (project_id, lower(name));

alter table tickets add column release_id uuid;
alter table tickets add constraint tickets_release_fkey
  foreign key (release_id, project_id) references releases (id, project_id) on delete set null (release_id);
create index tickets_release_id_idx on tickets (release_id) where release_id is not null;
