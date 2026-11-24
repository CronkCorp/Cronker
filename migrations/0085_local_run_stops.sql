-- Stops of local Runs (CRONK-142): a Run stopped in Cronk is told to its Machine, and told again on every connect
-- until the Machine confirms it killed the process. Runs already over need no confirming.
alter table local_runs add column stop_acked_at timestamptz;
update local_runs set stop_acked_at = now()
  where exists (select 1 from runs where runs.id = local_runs.run_id and runs.state not in ('running', 'lost'));
