-- The installation's one GitHub App, created through GitHub's manifest flow. Its client
-- secret, webhook secret and private key are stored encrypted with CRONK_SECRET_KEY.
create table github_app (
  id boolean primary key default true check (id),
  app_id bigint not null,
  slug text not null,
  name text not null,
  owner_login text not null,
  html_url text not null,
  client_id text not null,
  client_secret text not null,
  webhook_secret text,
  private_key text not null,
  created_by uuid references users (id),
  created_at timestamptz not null
);

-- Manifest flows an Admin started and GitHub hasn't sent back yet. Only the hash of each
-- flow's state is stored; each works once.
create table github_app_states (
  token_hash text primary key,
  user_id uuid not null references users (id),
  created_at timestamptz not null,
  expires_at timestamptz not null
);
create index github_app_states_user_id_idx on github_app_states (user_id);
