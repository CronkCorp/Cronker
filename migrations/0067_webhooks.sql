-- Webhooks (CRONK-80): a User's own channels for what waits in their Inbox in a Workspace. The signing secret is
-- sealed under CRONK_SECRET_KEY, since Cronk signs each delivery with it; it is shown only once, on creation.
create table webhooks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  name text not null,
  url text not null,
  -- The Inbox kinds it gets.
  kinds text[] not null,
  enabled boolean not null default true,
  secret_sealed text not null,
  created_at timestamptz not null
);
create index webhooks_owner on webhooks (workspace_id, user_id);

-- A webhook's deliveries, sent by the delivery check the server runs every few seconds. The body is kept as the exact
-- text sent, since its signature covers those bytes. One is due while `sent_at` is null and `next_at` has passed;
-- `attempts`, `next_at` and the retries that use them grow with later Tickets. Only the last 20 per webhook are kept.
create table webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  webhook_id uuid not null references webhooks (id) on delete cascade,
  kind text not null,
  body text not null,
  attempts integer not null default 0,
  status_code integer,
  error text,
  next_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null
);
create index webhook_deliveries_webhook on webhook_deliveries (webhook_id, created_at);
create index webhook_deliveries_due on webhook_deliveries (next_at) where sent_at is null;
