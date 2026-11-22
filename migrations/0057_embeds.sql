-- Embeds (CRONK-14): an Artifact's address alone in its paragraph shows the Artifact in place, and is recorded in the
-- Mention index as a Mention of the Artifact, at the Version the address names (`?version=N`) or its latest.
--
-- Unlike a Ticket key, an address names its Artifact by id, so a Mention of an Artifact is resolved when the text is
-- saved. Without a foreign key, so a test of an earlier migration can apply this one ahead of Artifacts: deleting an
-- Artifact removes its rows itself.
alter table mentions drop constraint mentions_target_kind_check;
alter table mentions add constraint mentions_target_kind_check check (target_kind in ('ticket', 'artifact'));
alter table mentions alter column project_key drop not null, alter column number drop not null;
alter table mentions
  add column target_artifact_id uuid,
  -- The Version the address names; null for the latest.
  add column target_version integer;
alter table mentions add constraint mentions_one_target check (
  (target_kind = 'ticket' and project_key is not null and number is not null and target_artifact_id is null)
  or (target_kind = 'artifact' and target_artifact_id is not null and project_key is null and number is null)
);
create index mentions_target_artifact_idx on mentions (target_artifact_id) where target_artifact_id is not null;

-- The texts already stored may hold Embeds: index them again on the next start.
insert into pending_backfills (name) values ('embeds');
