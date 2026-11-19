-- Each reviewer's latest review of a Pull Request in a Repository some Project lists, whatever its
-- Tickets' Statuses and whoever opened it: approved, changes requested, or dismissed once GitHub
-- dismisses it. Reviews that only comment are not kept. A review can arrive before the Pull Request
-- does, so it is kept by GitHub's id of the Pull Request, without a reference. `review_id` is
-- GitHub's, which grows with each new review, so a later review replaces the one before it and a
-- late delivery changes nothing.
create table pull_request_reviews (
  pull_request_id bigint not null,
  reviewer text not null,
  review_id bigint not null,
  state text not null check (state in ('approved', 'changes_requested', 'dismissed')),
  url text,
  primary key (pull_request_id, reviewer)
);
