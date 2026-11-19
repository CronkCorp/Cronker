-- Webhook deliveries Cronk has applied, by GitHub's delivery id, so one that arrives again
-- (GitHub's redelivery, or a replay) is applied once.
create table github_deliveries (
  id text primary key,
  event text not null,
  applied_at timestamptz not null
);
