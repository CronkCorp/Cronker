-- GitHub repositories Projects list as holding their code, known by GitHub's repository id.
-- The owner/name is kept for showing, and updated when GitHub reports a rename or transfer.
-- One row per repository for the whole installation, however many Projects list it.
create table repositories (
  id bigint primary key,
  full_name text not null,
  updated_at timestamptz not null
);

-- The Repositories each Project lists. Several Projects, in any Workspaces, may list one.
create table project_repositories (
  project_id uuid not null,
  workspace_id uuid not null,
  repository_id bigint not null references repositories (id),
  added_by uuid references users (id),
  added_at timestamptz not null,
  primary key (project_id, repository_id),
  foreign key (project_id, workspace_id) references projects (id, workspace_id)
);
create index project_repositories_repository_id_idx on project_repositories (repository_id);
