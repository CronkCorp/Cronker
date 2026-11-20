-- Artifacts: live pages an Actor builds, kept in a Project, or in the Workspace when it has no Project.
create table artifacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id),
  project_id uuid,
  -- The number of its current Version.
  version integer not null,
  created_at timestamptz not null,
  foreign key (project_id, workspace_id) references projects (id, workspace_id),
  constraint artifacts_id_workspace_key unique (id, workspace_id)
);
create index artifacts_place_idx on artifacts (workspace_id, project_id);

-- Versions: each save of an Artifact, numbered from 1, recording the Actor who saved it. Each is served from its own
-- unguessable key, under which its files' relative paths resolve.
create table artifact_versions (
  artifact_id uuid not null references artifacts (id) on delete cascade,
  number integer not null check (number >= 1),
  workspace_id uuid not null,
  title text not null,
  description text not null,
  -- The path of the file that is its page.
  page text not null,
  serve_key text not null unique,
  actor_user_id uuid references users (id),
  actor_agent_id uuid,
  saved_at timestamptz not null,
  primary key (artifact_id, number),
  foreign key (actor_agent_id, workspace_id) references agents (id, workspace_id),
  constraint artifact_versions_one_actor check (num_nonnulls(actor_user_id, actor_agent_id) = 1)
);

alter table artifacts add foreign key (id, version) references artifact_versions (artifact_id, number)
  deferrable initially deferred;

-- A Version's files, by their relative paths. Their bytes are kept by the Attachment storage under `blob_id`; a file
-- a save leaves as it was keeps the same bytes, so Versions share them.
create table artifact_files (
  artifact_id uuid not null,
  version integer not null,
  path text not null,
  media_type text not null,
  size bigint not null check (size >= 0),
  blob_id uuid not null,
  primary key (artifact_id, version, path),
  foreign key (artifact_id, version) references artifact_versions (artifact_id, number) on delete cascade
);
create index artifact_files_blob_idx on artifact_files (blob_id);
