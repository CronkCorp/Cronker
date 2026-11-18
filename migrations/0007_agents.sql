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

-- Agent tokens, full or read-only. Only the hash of each is stored; revoking one deletes it.
create table agent_tokens (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents (id),
  name text not null,
  access text not null check (access in ('full', 'read')),
  token_hash text not null unique,
  created_at timestamptz not null
);
create index agent_tokens_agent_id_idx on agent_tokens (agent_id);

-- Lets records an Agent makes insist they carry the Agent's own Workspace.
alter table agents add constraint agents_id_workspace_key unique (id, workspace_id);

-- A Comment's Actor is a User or an Agent, never both.
alter table comments alter column actor_user_id drop not null;
alter table comments add column actor_agent_id uuid;
alter table comments add foreign key (actor_agent_id, workspace_id) references agents (id, workspace_id);
alter table comments add constraint comments_one_actor check (num_nonnulls(actor_user_id, actor_agent_id) = 1);
