-- Runners: ways for Cronk to start Runs, each set up by one User, its Owner, with their own credentials.
-- `kind` names the Runner implementation that starts its Runs.
create table runners (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users (id),
  kind text not null,
  name text not null,
  created_at timestamptz not null,
  -- Lets an Agent insist its Runner is its Owner's.
  constraint runners_id_owner_key unique (id, owner_id)
);
create index runners_owner_id_idx on runners (owner_id);

-- Each Agent uses one of its Owner's Runners, or none yet.
alter table agents add column runner_id uuid;
alter table agents add foreign key (runner_id, owner_id) references runners (id, owner_id);

-- Lets a Ticket insist its Delegate is an Agent of the Ticket's own Workspace.
alter table tickets add column delegate_id uuid;
alter table tickets add foreign key (delegate_id, workspace_id) references agents (id, workspace_id);

-- Whether new Tickets of a Project start delegated to their creator's Agent.
alter table projects add column new_tickets_delegated boolean not null default false;

-- A Change's Actor is a User or an Agent, never both.
alter table changes alter column actor_user_id drop not null;
alter table changes add column actor_agent_id uuid;
alter table changes add foreign key (actor_agent_id, workspace_id) references agents (id, workspace_id);
alter table changes add constraint changes_one_actor check (num_nonnulls(actor_user_id, actor_agent_id) = 1);

-- Runs: one agent execution Cronk starts for one Ticket, as an Agent through one of its Owner's Runners.
-- The Step, its Status's name and model, and the Brief are kept as they were when the Run started.
create type run_state as enum ('running', 'finished', 'failed', 'refused');

create table runs (
  id uuid primary key default gen_random_uuid(),
  -- Orders Runs started at the same instant in the order they were started.
  seq bigint generated always as identity,
  workspace_id uuid not null references workspaces (id),
  ticket_id uuid not null,
  status_id uuid references statuses (id) on delete set null,
  status_name text not null,
  model text not null,
  agent_id uuid not null,
  -- None when the Agent used no Runner, so the Run was refused at once.
  runner_id uuid references runners (id),
  state run_state not null default 'running',
  brief jsonb not null,
  session_id text,
  session_url text,
  outcome text,
  question text,
  report text,
  -- Why a Run failed or its Runner refused to start it.
  end_reason text,
  started_at timestamptz not null,
  ended_at timestamptz,
  foreign key (ticket_id, workspace_id) references tickets (id, workspace_id),
  foreign key (agent_id, workspace_id) references agents (id, workspace_id)
);
create index runs_ticket_id_idx on runs (ticket_id, seq);
-- A Ticket has at most one running Run.
create unique index runs_one_running_per_ticket on runs (ticket_id) where state = 'running';
