-- Terms: each names one concept, kept by a Project, or by the Workspace when it has no Project. A name is unique
-- ignoring case among the Project's Terms, or among the Workspace's own; `name` is the current Version's, kept here
-- for that.
create table terms (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id),
  project_id uuid,
  name text not null,
  -- The number of its current Version.
  version integer not null,
  created_at timestamptz not null,
  foreign key (project_id, workspace_id) references projects (id, workspace_id)
);
create unique index terms_project_name_key on terms (project_id, lower(name)) where project_id is not null;
create unique index terms_workspace_name_key on terms (workspace_id, lower(name)) where project_id is null;

-- Versions: each save of a Term, numbered from 1, recording the Actor who saved it, a User or an Agent.
create table term_versions (
  term_id uuid not null references terms (id) on delete cascade,
  number integer not null check (number >= 1),
  workspace_id uuid not null,
  name text not null,
  definition text not null,
  -- The words to avoid in its place, in the order given.
  avoid text[] not null,
  actor_user_id uuid references users (id),
  actor_agent_id uuid,
  saved_at timestamptz not null,
  primary key (term_id, number),
  foreign key (actor_agent_id, workspace_id) references agents (id, workspace_id),
  constraint term_versions_one_actor check (num_nonnulls(actor_user_id, actor_agent_id) = 1)
);

alter table terms add foreign key (id, version) references term_versions (term_id, number)
  deferrable initially deferred;
