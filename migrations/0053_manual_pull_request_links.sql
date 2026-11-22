-- A User linking a Pull Request to a Ticket by hand (CRONK-40), alongside the links its branch or title makes by
-- naming the Ticket's key. A (Pull Request, Ticket) pair is one link either way: `by_key` says its key is named,
-- `manual_at` that a User linked it by hand, and `manual_by` which User did. Unlinking by hand clears only the
-- manual mark, so a key link stays; a link neither names any more is gone.
alter table pull_request_links
  add column by_key boolean not null default true,
  add column manual_by uuid references users (id) on delete set null,
  add column manual_at timestamptz,
  add constraint pull_request_links_kept check (by_key or manual_at is not null);
-- Existing links all came from keys; every later link says how it came.
alter table pull_request_links alter column by_key drop default;
