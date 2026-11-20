-- Search: Artifacts are searched at their current Version by title and description, never by their files, so a page's
-- markup doesn't drown other results. A title weighs more than the description.
alter table artifact_versions add column search tsvector generated always as (
  setweight(to_tsvector('english', title), 'A') || setweight(to_tsvector('english', description), 'B')
) stored;
create index artifact_versions_search_idx on artifact_versions using gin (search);
