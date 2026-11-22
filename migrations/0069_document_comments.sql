-- Comments on Documents (CRONK-66): a Comment is on exactly one Ticket, one Artifact or one Document, a Report
-- included. A reply is to a Comment on the same Document.
alter table comments add column document_id uuid;
alter table comments add foreign key (document_id, workspace_id) references documents (id, workspace_id);
alter table comments drop constraint comments_one_target;
alter table comments add constraint comments_one_target check (num_nonnulls(ticket_id, artifact_id, document_id) = 1);
alter table comments add constraint comments_id_document_key unique (id, document_id);
alter table comments add foreign key (reply_to_id, document_id) references comments (id, document_id);
create index comments_document_id_idx on comments (document_id, seq) where document_id is not null;
