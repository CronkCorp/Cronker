-- The Inbox items each webhook has already heard of (CRONK-83), by kind and source, so each pair of item and webhook
-- is delivered at most once. Items a turned-off webhook, or one that didn't choose their kind, saw are kept too, so
-- turning it on or adding a kind doesn't send what was already waiting. Rows outlive their items: an item that leaves
-- the Inbox and comes back isn't sent again.
create table webhook_inbox_seen (
  webhook_id uuid not null references webhooks (id) on delete cascade,
  item_key text not null,
  primary key (webhook_id, item_key)
);
