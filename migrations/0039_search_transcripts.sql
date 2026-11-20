-- Search over Transcripts: each entry keeps the words of its text, stemmed by Postgres's `english` configuration,
-- in a generated column with a GIN index. A tool call has no text, so no words.
alter table transcript_entries add column search tsvector generated always as (to_tsvector('english', text)) stored;
create index transcript_entries_search_idx on transcript_entries using gin (search);
