-- Cronk itself writes Comments, such as one linking the failing check or review that sent a
-- Ticket back: a Comment with neither a User nor an Agent is Cronk's.
alter table comments drop constraint comments_one_actor;
alter table comments add constraint comments_one_actor check (num_nonnulls(actor_user_id, actor_agent_id) <= 1);

-- Each time a failure on a Pull Request sent a linked Ticket back to its producing Step's Status:
-- a failing check on a head commit (`cause` is `commit:<sha>`) or a review requesting changes
-- (`review:<id>`). Each cause sends a Ticket back at most once. `what` is the failure as
-- reading the Ticket shows it.
create table sent_back (
  pull_request_id bigint not null references pull_requests (id),
  ticket_id uuid not null,
  workspace_id uuid not null,
  cause text not null,
  what jsonb not null,
  sent_at timestamptz not null,
  -- Orders sends at the same instant in the order they were made.
  seq bigint generated always as identity,
  primary key (pull_request_id, ticket_id, cause),
  foreign key (ticket_id, workspace_id) references tickets (id, workspace_id)
);
