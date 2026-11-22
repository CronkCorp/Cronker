-- Autonomous Tickets join the Merge Queue (CRONK-95): an entry is queued either by a User, who pressed Merge, or by
-- Autonomous Delegation, for the Agent the Ticket was delegated to, whose merge Cronk then records it as.
alter table merge_queue alter column queued_by_user_id drop not null;
alter table merge_queue add column queued_by_agent_id uuid references agents (id) on delete cascade;
alter table merge_queue add constraint merge_queue_queued_by_check
  check ((queued_by_user_id is null) <> (queued_by_agent_id is null));
