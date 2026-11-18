-- The subscription Runner's triggers: for each model label, the claude.ai scheduled task it fires, with that
-- trigger's token sealed under CRONK_SECRET_KEY. A trigger with a Project overrides the Runner's own trigger
-- for that model on the Project's Tickets.
create table runner_triggers (
  id uuid primary key default gen_random_uuid(),
  runner_id uuid not null references runners (id) on delete cascade,
  project_id uuid references projects (id) on delete cascade,
  -- The model label as the User typed it; matched against a Step's model ignoring case.
  model text not null,
  trigger_id text not null,
  token_sealed text not null,
  created_at timestamptz not null
);
-- One trigger per model for the Runner, and one per model for each Project it overrides.
create unique index runner_triggers_default_key on runner_triggers (runner_id, lower(model)) where project_id is null;
create unique index runner_triggers_project_key on runner_triggers (runner_id, project_id, lower(model)) where project_id is not null;

-- Until when a rate-limited Runner's queue is paused: none of its waiting Tickets start until the periodic
-- check, at or after this time, clears it and gives out its free slots.
alter table runners add column paused_until timestamptz;
