-- Webhook retries (CRONK-84): a delivery that fails is tried again with backoff for about 24 hours. Each try is kept
-- as an attempt with its status code (or why there was none) and time. A delivery stays due (`sent_at` null) while
-- retries remain; `sent_at` is set when it is delivered or given up on. A webhook whose delivery was given up on is
-- `failing` until its next delivery succeeds.
alter table webhooks add column failing boolean not null default false;

create table webhook_attempts (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references webhook_deliveries (id) on delete cascade,
  at timestamptz not null,
  status_code integer,
  error text
);
create index webhook_attempts_delivery on webhook_attempts (delivery_id, at);
