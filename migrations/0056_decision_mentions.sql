-- Decision Mentions (CRONK-12): texts mention Decisions as well as Tickets, by a Project Decision's key, such as
-- `WEB-D7`, or by a Workspace Decision's, such as `D7`, so a text links them and each Decision lists the texts
-- mentioning it (Mentioned in). A Mention of a Workspace Decision has no Project key.
alter table mentions drop constraint mentions_target_kind_check;
alter table mentions add constraint mentions_target_kind_check check (target_kind in ('ticket', 'decision'));
alter table mentions alter column project_key drop not null;
alter table mentions add constraint mentions_ticket_project_key check (target_kind <> 'ticket' or project_key is not null);
create index mentions_target_decision_idx on mentions (workspace_id, project_key, number) where target_kind = 'decision';

-- The texts already stored have their Decision keys to index: Cronk does it on its next start, reading each text
-- again. A database migrating through 0055 as well still has its marker, which serves both.
insert into pending_backfills (name) values ('mentions') on conflict do nothing;
