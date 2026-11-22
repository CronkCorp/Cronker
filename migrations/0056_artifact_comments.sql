-- Comments on Artifacts (CRONK-15): a Comment is on exactly one Ticket or one Artifact. A reply is to a Comment on the
-- same Ticket, or the same Artifact. A Comment on an Artifact linked to a Ticket also shows with the Ticket's.
alter table comments alter column ticket_id drop not null;
alter table comments add column artifact_id uuid;
alter table comments add foreign key (artifact_id, workspace_id) references artifacts (id, workspace_id);
alter table comments add constraint comments_one_target check (num_nonnulls(ticket_id, artifact_id) = 1);
alter table comments add constraint comments_id_artifact_key unique (id, artifact_id);
alter table comments add foreign key (reply_to_id, artifact_id) references comments (id, artifact_id);
create index comments_artifact_id_idx on comments (artifact_id, seq) where artifact_id is not null;
