-- Full tokens (CRONK-126): an Agent with a Full token deletes and redacts Transcripts as its Owner would, so who did
-- it is a User or an Agent, exactly one of them.
alter table transcripts add column deleted_by_agent uuid references agents (id);
alter table transcripts add constraint transcripts_deleted_by_one_check
  check (deleted_by is null or deleted_by_agent is null);

alter table transcript_redactions alter column added_by drop not null;
alter table transcript_redactions add column added_by_agent uuid references agents (id);
alter table transcript_redactions add constraint transcript_redactions_added_by_one_check
  check ((added_by is null) <> (added_by_agent is null));
