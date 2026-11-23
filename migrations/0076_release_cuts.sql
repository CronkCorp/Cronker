-- Cutting a Release (CRONK-115): a User with Write cuts a planned Release, and Cronk creates `release/<name>` at the
-- default branch's head in each Repository the Project lists. The Release records who cut it and when, and each
-- Repository's cut commit.
alter table releases add column cut_by uuid references users (id);
alter table releases add column cut_at timestamptz;

create table release_repositories (
  release_id uuid not null references releases (id) on delete cascade,
  repository_id bigint not null references repositories (id),
  cut_sha text not null,
  primary key (release_id, repository_id)
);
