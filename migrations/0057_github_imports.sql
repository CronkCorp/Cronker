-- Importing a Repository's GitHub issues into a Project (CRONK-82): an Admin starts an import, which runs as a
-- background job, a page of issues at a time, until GitHub has listed them all. `next_page` is the page of GitHub's
-- issues, oldest first, the next pass reads, so a restart resumes where it stopped. Only one import runs per Project.
create table github_imports (
  id uuid primary key default gen_random_uuid(),
  -- Orders imports started at the same moment.
  seq bigint generated always as identity,
  project_id uuid not null,
  workspace_id uuid not null,
  repository_id bigint not null,
  repository_full_name text not null,
  started_by uuid not null references users (id),
  state text not null check (state in ('running', 'done', 'failed')),
  next_page integer not null default 1,
  imported integer not null default 0,
  skipped integer not null default 0,
  error text,
  started_at timestamptz not null,
  finished_at timestamptz,
  foreign key (project_id, workspace_id) references projects (id, workspace_id) on delete cascade
);
create unique index github_imports_running_idx on github_imports (project_id) where state = 'running';
create index github_imports_project_idx on github_imports (project_id, repository_id, seq desc);

-- A Ticket imported from a GitHub issue keeps the issue's node id, so importing again skips it, and its address.
alter table tickets add column github_issue_node_id text;
alter table tickets add column github_issue_url text;
create unique index tickets_github_issue_idx on tickets (project_id, github_issue_node_id) where github_issue_node_id is not null;
