-- Archived Projects (CRONK-75): an Admin archives a Project, making it read-only until it is unarchived.
alter table projects add column archived_at timestamptz;
alter table projects add column archived_by uuid references users (id) on delete set null;
alter table projects add constraint projects_archived_by_check check (archived_by is null or archived_at is not null);
