-- Deleting one Artifact Version (CRONK-73): a User deletes a single Version, such as one that leaked something, and
-- keeps the others. Version numbers are never reused, so the Artifact counts the Versions it has numbered: a missing
-- number at or under it is a deleted Version, and the next save takes the one after it.
alter table artifacts add column last_version integer;
update artifacts set last_version = (select max(number) from artifact_versions where artifact_id = artifacts.id);
alter table artifacts alter column last_version set not null;
