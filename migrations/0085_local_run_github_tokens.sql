-- Repositories in local Runs (CRONK-140): a claim carries fresh GitHub App installation tokens for the Project's
-- Repositories, and heartbeats give fresh ones before these expire. When the earliest of them expires is kept here.
alter table local_runs add column tokens_expire_at timestamptz;
