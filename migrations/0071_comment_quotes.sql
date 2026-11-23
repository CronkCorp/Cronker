-- Comments anchored to a passage (CRONK-67): a Comment on a Document may quote a passage of the Version it was written
-- on, which it records by number. A Comment without a quote applies to the whole Document.
alter table comments add column quote text;
alter table comments add column quote_version integer;
alter table comments add constraint comments_quote_on_document check (
  (quote is null and quote_version is null) or (quote is not null and quote <> '' and quote_version is not null and document_id is not null)
);
alter table comments add foreign key (document_id, quote_version) references document_versions (document_id, number);
