-- A `managed_agents` Runner keeps its Owner's Anthropic API key, sealed under CRONK_SECRET_KEY, and the agent
-- definition and cloud environment Cronk created with it in their Anthropic workspace.
alter table runners add column api_key_sealed text;
alter table runners add column managed_agent_id text;
alter table runners add column managed_environment_id text;

-- What a Managed Agents Run holds in Cronk and in Anthropic: the Agent token made for it, the vault of its own that
-- holds the token, and its session. Once the Run ends, each is let go of and its time recorded: the token revoked,
-- the vault deleted, the session archived; the server's poll tries again for whatever Anthropic didn't take. The
-- sealed key is copied from the Runner so this still works once the Runner is removed. `run_id` is no foreign key,
-- since a Run refused for a rate limit is unrecorded while what it held may still need letting go of.
create table managed_agent_runs (
  run_id uuid primary key,
  api_key_sealed text not null,
  token_id uuid,
  vault_id text,
  session_id text,
  revoked_at timestamptz,
  vault_deleted_at timestamptz,
  archived_at timestamptz
);
create index managed_agent_runs_unfinished_idx on managed_agent_runs (run_id)
  where revoked_at is null or vault_deleted_at is null or archived_at is null;
