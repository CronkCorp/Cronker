-- OAuth clients of Cronk's MCP server: registered dynamically, with an id Cronk made up, or
-- named by the URL of their Client ID Metadata Document, which Cronk fetched and keeps a copy of.
create table oauth_clients (
  id text primary key,
  name text,
  redirect_uris text[] not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

-- An authorization a client asked for, waiting on the consent screen. Approving it picks the
-- Agent and issues a one-time code, of which only the hash is kept; denying or trading the
-- code in uses it up.
create table oauth_requests (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references oauth_clients (id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,
  state text,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  agent_id uuid references agents (id),
  code_hash text unique,
  used_at timestamptz
);
create index oauth_requests_expires_at_idx on oauth_requests (expires_at);

-- A token issued by OAuth is an Agent token like any other, listed and revoked with the
-- Agent's tokens, except that it expires and is renewed with a refresh token, of which
-- only the hash is kept.
alter table agent_tokens add column oauth_client_id text references oauth_clients (id) on delete cascade;
alter table agent_tokens add column expires_at timestamptz;
alter table agent_tokens add column refresh_hash text unique;
alter table agent_tokens add constraint agent_tokens_oauth_check
  check ((oauth_client_id is null) = (refresh_hash is null) and (oauth_client_id is null) = (expires_at is null));
