-- Local Runs (CRONK-139): a Run of a `local` Runner waits, claimable, until a Machine serving its Runner claims it.
-- The claim is recorded here, once per Run, with the Agent token minted for the Run, revoked once the Run ends.
create table local_runs (
  run_id uuid primary key references runs (id) on delete cascade,
  machine_id uuid not null references machines (id) on delete cascade,
  token_id uuid,
  claimed_at timestamptz not null,
  revoked_at timestamptz
);
create index local_runs_machine on local_runs (machine_id);
