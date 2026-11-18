-- The installation itself: one row, holding the hash of the one-time setup code until setup runs.
create table installation (
  id boolean primary key default true check (id),
  setup_code_hash text,
  set_up_at timestamptz
);

-- Users span Workspaces, so they carry no Workspace; they belong to Workspaces through memberships.
create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  password_hash text,
  created_at timestamptz not null
);
create unique index users_email_key on users (lower(email));

create table workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null
);

create table memberships (
  workspace_id uuid not null references workspaces (id),
  user_id uuid not null references users (id),
  is_admin boolean not null default false,
  created_at timestamptz not null,
  primary key (workspace_id, user_id)
);
