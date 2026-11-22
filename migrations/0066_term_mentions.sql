-- Term Mentions (CRONK-13): a Term's name, written with its capitalisation as a whole word, mentions the Term in every
-- indexed text, by the glossary of the text's place: a Project's text by its Project's Terms over the Workspace's, any
-- other by the Workspace's. A Term row names its Term by id.
alter table mentions drop constraint mentions_target_kind_check;
alter table mentions add constraint mentions_target_kind_check check (target_kind in ('ticket', 'artifact', 'term'));
-- Without a foreign key, as for the source columns, so a test of an earlier migration can apply this one ahead of
-- Terms: deleting a Term removes its rows itself.
alter table mentions add column target_term_id uuid;
alter table mentions drop constraint mentions_one_target;
alter table mentions add constraint mentions_one_target check (
  (target_kind = 'ticket' and project_key is not null and number is not null
    and target_artifact_id is null and target_term_id is null)
  or (target_kind = 'artifact' and target_artifact_id is not null and project_key is null and number is null
    and target_term_id is null)
  or (target_kind = 'term' and target_term_id is not null and project_key is null and number is null
    and target_artifact_id is null)
);
create index mentions_target_term_idx on mentions (target_term_id) where target_kind = 'term';

-- Index the texts already stored again, now with Term names, on the next start.
insert into pending_backfills (name) values ('term-mentions') on conflict do nothing;
