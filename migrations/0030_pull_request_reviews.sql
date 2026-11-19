-- Each reviewer's latest review of a Pull Request Cronk knows, whatever its Tickets' Statuses and whoever
-- opened it: approved, changes requested, or dismissed once GitHub dismisses it. Reviews that only
-- comment are not kept. `review_id` is GitHub's, which grows with each new review, so a later review
-- replaces the one before it and a late delivery changes nothing.
create table pull_request_reviews (
  pull_request_id bigint not null references pull_requests (id),
  reviewer text not null,
  review_id bigint not null,
  state text not null check (state in ('approved', 'changes_requested', 'dismissed')),
  url text,
  primary key (pull_request_id, reviewer)
);
