-- The completed check suites GitHub reported on a commit of a Repository, each by GitHub's id.
-- A workflow that fails before it creates any check run, such as one with an invalid workflow
-- file, shows only as its failing suite. A rerun rerequests the same suite, which stops it
-- failing until it completes again, so the delivery GitHub updated last wins. Suites aren't shown among a Pull Request's checks; a
-- failing one only sends work back.
create table commit_check_suites (
  repository_id bigint not null,
  sha text not null,
  id bigint not null,
  -- The name of the GitHub App that ran it, such as GitHub Actions.
  app_name text not null,
  failed boolean not null,
  url text,
  updated_at timestamptz not null,
  primary key (repository_id, sha, id)
);
