-- An import keeps the structure of the issues it brings (CRONK-88). Once every page is read it turns to `linking`: a
-- pass at a time it makes Sub-Tickets of sub-issues, blocks of dependencies and Ticket keys of `#123`, from the issues
-- `github_import_links` queues, until none are left. A Ticket remembers the import that made it, its issue's number
-- and the Repository, so `#123` resolves to a Ticket imported in this run or an earlier one.
alter table github_imports add column phase text not null default 'issues' check (phase in ('issues', 'linking'));

alter table tickets add column github_repository_id bigint;
alter table tickets add column github_issue_number integer;
alter table tickets add column github_import_id uuid references github_imports (id) on delete set null;
create index tickets_github_issue_number_idx on tickets (project_id, github_repository_id, github_issue_number)
  where github_issue_number is not null;

-- The issues an import still has to link: any one GitHub says has sub-issues or is blocked, and any one it made a
-- Ticket of whose title or body refers to `#123`, which it rewrites.
create table github_import_links (
  import_id uuid not null references github_imports (id) on delete cascade,
  ticket_id uuid not null references tickets (id) on delete cascade,
  issue_number integer not null,
  sub_issues boolean not null,
  blocked_by boolean not null,
  primary key (import_id, ticket_id)
);
create index github_import_links_order_idx on github_import_links (import_id, issue_number);
