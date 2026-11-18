-- One-time links: joining a Workspace (setting a password first if the User has none)
-- and resetting a password. Only the hash of each link's secret is stored.
create table links (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('join', 'reset')),
  user_id uuid not null references users (id),
  workspace_id uuid references workspaces (id),
  token_hash text not null unique,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  check ((kind = 'join') = (workspace_id is not null))
);
create index links_user_id_idx on links (user_id);
