-- Webhook deliveries Cronk has applied, by GitHub's delivery id, so one GitHub sends again
-- (a redelivery) is applied once.
create table github_deliveries (
  id text primary key,
  event text not null,
  applied_at timestamptz not null
);

-- When Cronk last knew GitHub signs deliveries with the App's webhook secret: GitHub made it
-- in the manifest flow, or a delivery came signed with it. GitHub never shows the secret,
-- so one Cronk made for an App created without a webhook is unconfirmed until then.
alter table github_app add column webhook_secret_confirmed_at timestamptz;
