-- When a Project was last unarchived (CRONK-85). Inbox items of an archived Project reach no webhook, and on
-- unarchive the items that began waiting before it are recorded as heard of rather than sent.
alter table projects add column unarchived_at timestamptz;
