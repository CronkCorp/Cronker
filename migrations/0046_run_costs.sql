-- What a Run cost, where its Runner reports it (a Managed Agents session's list cost; subscription Runs report none):
-- an amount in the currency's minor units, such as US cents, with the currency. Both or neither.
alter table runs add column cost_amount bigint;
alter table runs add column cost_currency text;
alter table runs add constraint runs_cost_check check ((cost_amount is null) = (cost_currency is null) and cost_amount >= 0);

-- Per Runner per month, its Runs' costs are summed by when they ended.
create index runs_runner_cost_idx on runs (runner_id, ended_at) where cost_amount is not null;

-- A `managed_agents` Runner's budget per Run, in US cents, passed as each session's budget; null for none.
alter table runners add column budget_per_run integer check (budget_per_run > 0);
