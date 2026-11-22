-- Decision Mentions (CRONK-12): texts mention Decisions as well as Tickets, by a Project Decision's key, such as
-- `WEB-D7`, or by a Workspace Decision's, such as `D7`, so a text links them and each Decision lists the texts
-- mentioning it (Mentioned in). A Mention of a Workspace Decision has no Project key.
alter table mentions drop constraint mentions_target_kind_check;
alter table mentions add constraint mentions_target_kind_check check (target_kind in ('ticket', 'artifact', 'decision'));
alter table mentions drop constraint mentions_one_target;
alter table mentions add constraint mentions_one_target check (
  (target_kind = 'ticket' and project_key is not null and number is not null and target_artifact_id is null)
  or (target_kind = 'artifact' and target_artifact_id is not null and project_key is null and number is null)
  or (target_kind = 'decision' and number is not null and target_artifact_id is null and target_version is null)
);
create index mentions_target_decision_idx on mentions (workspace_id, project_key, number) where target_kind = 'decision';

-- The texts already stored have their Decision keys to index: Cronk does it on its next start, reading each text
-- again. A database migrating through 0055 or 0057 as well still has its marker, which serves both.
insert into pending_backfills (name) values ('decision-mentions') on conflict do nothing;
