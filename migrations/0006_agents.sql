-- Agents: non-human accounts acting for exactly one User, their Owner, in one Workspace.
-- A removed Agent keeps its row, so what it did still shows who did it, but is refused at once.
-- Names are unique among a Workspace's Agents still in use, ignoring case.
create table agents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id),
  owner_id uuid not null references users (id),
  name text not null,
  created_at timestamptz not null,
  removed_at timestamptz
);
create unique index agents_workspace_name_key on agents (workspace_id, lower(name)) where removed_at is null;
create index agents_owner_id_idx on agents (owner_id);
