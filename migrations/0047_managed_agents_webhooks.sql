-- The signing secret of a `managed_agents` Runner's webhook endpoint, which its Owner adds in the Anthropic Console
-- and pastes back, sealed under CRONK_SECRET_KEY. Without one, Runs end only by polling.
alter table runners add column webhook_secret_sealed text;
