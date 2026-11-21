-- The model id each model label stands for in a Workspace, as an ordered list of { label, modelId }, labels unique
-- ignoring case. A Runner setup gives each routine the model id of its label. It ships with the latest model of
-- each family the default board uses; Admins change it as new models come out.
alter table workspaces add column model_ids jsonb not null default
  '[{"label": "haiku", "modelId": "claude-haiku-5-5"}, {"label": "sonnet", "modelId": "claude-sonnet-5-5"}, {"label": "opus", "modelId": "claude-opus-5-5"}]';

-- A trigger made by a Runner setup waits for its token until the User pastes it.
alter table runner_triggers alter column token_sealed drop not null;

-- A Runner setup: a one-time, short-lived handoff in which a User's Claude Code creates a Project's routines and
-- reports their trigger ids back with the setup token, of which only the hash is kept. The Transcript hook token
-- issued for it is sealed under CRONK_SECRET_KEY until the setup is used, since only its instructions hand it over.
create table runner_setups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  runner_id uuid not null references runners (id) on delete cascade,
  project_id uuid not null references projects (id) on delete cascade,
  agent_id uuid not null references agents (id) on delete cascade,
  token_hash text not null unique,
  hook_token_sealed text,
  -- What the setup creates, as it was shown when it started: the routines per model label.
  plan jsonb not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null
);
create index runner_setups_runner on runner_setups (runner_id);
