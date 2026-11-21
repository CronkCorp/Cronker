-- Access levels per Project (ADR 0010). A Project is open or private and may list Users with Read or Write; each
-- Project, and the Workspace for its own knowledge, sets an Agent Access. Existing Projects start open, with Agent
-- Access Write, so nothing changes until an Admin restricts one.
alter table projects add column visibility text not null default 'open' check (visibility in ('open', 'private'));
alter table projects add column agent_access text not null default 'write' check (agent_access in ('write', 'read', 'none'));
alter table workspaces add column agent_access text not null default 'write' check (agent_access in ('write', 'read', 'none'));

-- The Users listed on a Project, each with Read or Write. A listed User belongs to the Project's Workspace: leaving
-- it takes them off its Projects' lists.
create table project_members (
  project_id uuid not null,
  workspace_id uuid not null,
  user_id uuid not null,
  level text not null check (level in ('read', 'write')),
  created_at timestamptz not null,
  primary key (project_id, user_id),
  foreign key (project_id, workspace_id) references projects (id, workspace_id) on delete cascade,
  foreign key (workspace_id, user_id) references memberships (workspace_id, user_id) on delete cascade
);
create index project_members_user_id on project_members (user_id);
