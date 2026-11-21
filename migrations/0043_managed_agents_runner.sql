-- A `managed_agents` Runner keeps its Owner's Anthropic API key, sealed under CRONK_SECRET_KEY, and the agent
-- definition and cloud environment Cronk created with it in their Anthropic workspace.
alter table runners add column api_key_sealed text;
alter table runners add column managed_agent_id text;
alter table runners add column managed_environment_id text;

-- What a Managed Agents Run holds in Anthropic and in Cronk until it ends: its session, the vault of its own that
-- the session names, and the Agent token in that vault. The sealed key is copied from the Runner so a Run can still
-- be stopped and archived once its Runner is removed. `released_at` is set once its token was revoked and its vault
-- deleted, as every ended Run's are.
create table managed_agent_runs (
  run_id uuid primary key references runs (id) on delete cascade,
  api_key_sealed text not null,
  token_id uuid,
  vault_id text,
  session_id text,
  released_at timestamptz
);
create index managed_agent_runs_held_idx on managed_agent_runs (run_id) where released_at is null;
