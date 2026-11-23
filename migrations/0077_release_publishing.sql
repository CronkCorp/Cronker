-- Publishing a Release (CRONK-118): a User with Write releases a cut Release, and Cronk tags each release branch's head
-- `<name>` and creates a GitHub Release in each Repository it was cut in. The Release records who released it, when,
-- and the Upgrade notes written for it; each Repository records its tag and its GitHub Release's address.
alter table releases add column released_by uuid references users (id);
alter table releases add column released_at timestamptz;
alter table releases add column upgrade_notes text;

alter table release_repositories add column tag text;
alter table release_repositories add column release_url text;
