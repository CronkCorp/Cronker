-- Search: each searchable kind keeps its words, stemmed by Postgres's `english` configuration, in a generated
-- column with a GIN index. A title weighs more than the text beneath it.
alter table tickets add column search tsvector generated always as (
  setweight(to_tsvector('english', title), 'A') || setweight(to_tsvector('english', description), 'B')
) stored;
create index tickets_search_idx on tickets using gin (search);

-- Documents and Reports, Terms and Decisions are searched at their current Version.
alter table document_versions add column search tsvector generated always as (
  setweight(to_tsvector('english', title), 'A') || setweight(to_tsvector('english', body), 'B')
) stored;
create index document_versions_search_idx on document_versions using gin (search);

alter table decision_versions add column search tsvector generated always as (
  setweight(to_tsvector('english', title), 'A') || setweight(to_tsvector('english', body), 'B')
) stored;
create index decision_versions_search_idx on decision_versions using gin (search);

-- A Term's words to avoid weigh least. `array_to_string` is only stable, as some arrays' text depends on settings; a
-- text array's never does, so this wrapper may be used in a generated column.
create function search_words(words text[]) returns text language sql immutable parallel safe
  as $$ select array_to_string(words, ' ') $$;
alter table term_versions add column search tsvector generated always as (
  setweight(to_tsvector('english', name), 'A') || setweight(to_tsvector('english', definition), 'B')
    || setweight(to_tsvector('english', search_words(avoid)), 'C')
) stored;
create index term_versions_search_idx on term_versions using gin (search);
