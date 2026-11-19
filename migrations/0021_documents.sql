-- Documents: Markdown in the page tree of a Project, or of the Workspace when it has no Project. Each has a parent
-- in the same tree, or none at its top, and a place among its siblings, counting from 0.
create table documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id),
  project_id uuid,
  parent_id uuid,
  position integer not null check (position >= 0),
  -- The number of its current Version.
  version integer not null,
  created_at timestamptz not null,
  foreign key (project_id, workspace_id) references projects (id, workspace_id),
  constraint documents_id_workspace_key unique (id, workspace_id)
);
alter table documents add foreign key (parent_id, workspace_id) references documents (id, workspace_id);
create index documents_tree_idx on documents (workspace_id, project_id, parent_id, position);

-- Versions: each save of a Document, numbered from 1, recording the Actor who saved it, a User or an Agent.
create table document_versions (
  document_id uuid not null references documents (id) on delete cascade,
  number integer not null check (number >= 1),
  workspace_id uuid not null,
  title text not null,
  body text not null,
  actor_user_id uuid references users (id),
  actor_agent_id uuid,
  saved_at timestamptz not null,
  primary key (document_id, number),
  foreign key (actor_agent_id, workspace_id) references agents (id, workspace_id),
  constraint document_versions_one_actor check (num_nonnulls(actor_user_id, actor_agent_id) = 1)
);

alter table documents add foreign key (id, version) references document_versions (document_id, number)
  deferrable initially deferred;
