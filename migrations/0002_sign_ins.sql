-- Sign-ins. Only the hash of each sign-in token is stored.
create table sign_ins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id),
  token_hash text not null unique,
  created_at timestamptz not null,
  expires_at timestamptz not null
);
create index sign_ins_user_id_idx on sign_ins (user_id);
