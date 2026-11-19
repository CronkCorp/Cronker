-- Decisions: recorded choices with their reasoning, of a Project, or of the Workspace when they have no Project.
-- Numbered from 1 in order of creation, separately for each Project and for the Workspace. Never deleted.
create table decisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id),
  project_id uuid,
  number integer not null check (number >= 1),
  -- The number of its current Version.
  version integer not null,
  created_at timestamptz not null,
  foreign key (project_id, workspace_id) references projects (id, workspace_id),
  constraint decisions_id_workspace_key unique (id, workspace_id),
  constraint decisions_number_key unique nulls not distinct (workspace_id, project_id, number)
);

-- Versions: each save of a Decision, numbered from 1: its text and status, and the Actor who saved it.
create table decision_versions (
  decision_id uuid not null references decisions (id),
  number integer not null check (number >= 1),
  workspace_id uuid not null,
  title text not null,
  body text not null,
  status text not null check (status in ('proposed', 'accepted', 'rejected', 'deprecated', 'superseded')),
  -- The Decision replacing it, in the same Project or both in the Workspace; only while superseded.
  superseded_by_id uuid,
  actor_user_id uuid references users (id),
  actor_agent_id uuid,
  saved_at timestamptz not null,
  primary key (decision_id, number),
  foreign key (actor_agent_id, workspace_id) references agents (id, workspace_id),
  foreign key (superseded_by_id, workspace_id) references decisions (id, workspace_id),
  constraint decision_versions_one_actor check (num_nonnulls(actor_user_id, actor_agent_id) = 1),
  constraint decision_versions_superseded_by check ((status = 'superseded') = (superseded_by_id is not null))
);

alter table decisions add foreign key (id, version) references decision_versions (decision_id, number)
  deferrable initially deferred;
