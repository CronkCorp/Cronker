-- An import GitHub rate-limits waits until the limit lifts (CRONK-89): `paused_until` is when its next pass reads
-- the same page again; null while it isn't waiting.
alter table github_imports add column paused_until timestamptz;
