-- Estimated costs (CRONK-143): a local Run's cost is what Claude Code's stream reports (`total_cost_usd`), a figure at
-- list prices rather than money spent on a subscription login, so it is marked as an estimate. Costs recorded before
-- stay real, as a Managed Agents session's are.
alter table runs add column cost_estimate boolean not null default false;
