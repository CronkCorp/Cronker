-- Machines (CRONK-138): a User's own computer running the `cronk-runner` daemon, paired with this Cronk to serve
-- some of that User's `local` Runners. Its Machine token is kept only as a hash; unpairing revokes it.
create table machines (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users (id) on delete cascade,
  name text not null,
  os text not null,
  daemon_version text not null,
  -- The most Runs the Machine runs at once, across all its Runners, as its daemon's config sets it.
  run_limit integer not null default 2 check (run_limit >= 1),
  token_hash text unique,
  paired_at timestamptz not null,
  last_contact_at timestamptz,
  revoked_at timestamptz
);
create index machines_owner on machines (owner_id) where revoked_at is null;

-- Which of its Owner's `local` Runners each Machine serves.
create table machine_runners (
  machine_id uuid not null references machines (id) on delete cascade,
  runner_id uuid not null references runners (id) on delete cascade,
  primary key (machine_id, runner_id)
);
create index machine_runners_runner on machine_runners (runner_id);

-- A pairing waiting for its User: the daemon holds the device code (kept only as a hash) and polls with it, while
-- the User types the short user code on the Runners page. It expires ten minutes after it is made and is redeemed
-- once, for the Machine token of the Machine its approval made.
create table machine_pairings (
  id uuid primary key default gen_random_uuid(),
  device_code_hash text not null unique,
  user_code text not null unique,
  name text not null,
  os text not null,
  daemon_version text not null,
  run_limit integer not null check (run_limit >= 1),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  machine_id uuid references machines (id) on delete cascade,
  approved_at timestamptz,
  redeemed_at timestamptz
);
