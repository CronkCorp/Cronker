-- Pull Requests in Repositories Projects list, known by GitHub's id, as the latest delivery
-- about each reported them. `updated_at` is GitHub's, so a delivery arriving late can't bring
-- back an older state. Kept even once no Project lists the Repository, so the Tickets they
-- link to still show them.
create table pull_requests (
  id bigint primary key,
  repository_id bigint not null,
  repository_full_name text not null,
  number integer not null,
  title text not null,
  branch text not null,
  head_sha text not null,
  state text not null check (state in ('open', 'draft', 'merged', 'closed')),
  url text not null,
  updated_at timestamptz not null
);
create index pull_requests_head_idx on pull_requests (repository_id, head_sha);

-- Which Tickets each Pull Request links to, by a key in its branch or title. Links are only
-- ever added. The producing Run is the one running on the Ticket when GitHub reported the
-- Pull Request opened; its Status holds the producing Step. A Run a rate limit kept from
-- starting is forgotten, and so is its producing.
create table pull_request_links (
  pull_request_id bigint not null references pull_requests (id),
  ticket_id uuid not null,
  workspace_id uuid not null,
  producing_run_id uuid references runs (id) on delete set null,
  linked_at timestamptz not null,
  primary key (pull_request_id, ticket_id),
  foreign key (ticket_id, workspace_id) references tickets (id, workspace_id)
);
create index pull_request_links_ticket_id_idx on pull_request_links (ticket_id);

-- The checks GitHub reported on a commit of a Repository: check runs and commit statuses,
-- the latest of each by name. `source_id` is GitHub's id of the check run or status, which
-- grows with each new one, so a rerun replaces the run before it and a late delivery
-- changes nothing.
create table commit_checks (
  repository_id bigint not null,
  sha text not null,
  kind text not null check (kind in ('check_run', 'status')),
  name text not null,
  source_id bigint not null,
  state text not null check (state in ('pending', 'passed', 'failed', 'neutral')),
  -- Orders the stages of one check run: queued, in progress, completed.
  stage integer not null,
  url text,
  primary key (repository_id, sha, kind, name)
);
