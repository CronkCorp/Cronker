-- A deleted Transcript keeps its row without its entries, so its Run can say it was deleted and a later upload of its
-- session is refused instead of bringing back what was deleted.
alter table transcripts
  add column deleted_at timestamptz,
  add column deleted_by uuid references users (id);
