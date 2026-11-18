-- Sign-ins. Only the hash of each session token is stored.
create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id),
  token_hash text not null unique,
  created_at timestamptz not null,
  expires_at timestamptz not null
);
create index sessions_user_id_idx on sessions (user_id);
