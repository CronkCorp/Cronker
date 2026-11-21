-- The Repositories a Managed Agents Run's session mounts, each a resource of the session holding a GitHub App
-- installation token, and when that token expires. While the Run runs, Cronk sets a fresh token on each resource
-- before its token expires.
create table managed_agent_run_resources (
  run_id uuid not null references managed_agent_runs (run_id) on delete cascade,
  resource_id text not null,
  repository_id bigint not null,
  token_expires_at timestamptz not null,
  primary key (run_id, resource_id)
);
create index managed_agent_run_resources_expiry_idx on managed_agent_run_resources (token_expires_at);
