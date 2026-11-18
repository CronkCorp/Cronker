-- Questions: what a Run asks a User when it finishes with its Step's *needs you* Outcome.
-- Each is shown on its Ticket as a Comment from the Run's Agent. The first User's reply to that
-- Comment answers it; a User may instead dismiss it from the Inbox.
create table questions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id),
  ticket_id uuid not null,
  run_id uuid not null references runs (id),
  comment_id uuid not null,
  -- The Status of the Step that asked, where answering sends the Ticket back; null once it is removed.
  step_status_id uuid references statuses (id) on delete set null,
  step_status_name text not null,
  asked_at timestamptz not null,
  answer_comment_id uuid,
  answered_at timestamptz,
  dismissed_at timestamptz,
  dismissed_by uuid references users (id),
  foreign key (ticket_id, workspace_id) references tickets (id, workspace_id),
  foreign key (comment_id, ticket_id) references comments (id, ticket_id),
  foreign key (answer_comment_id, ticket_id) references comments (id, ticket_id),
  constraint questions_run_key unique (run_id),
  constraint questions_comment_key unique (comment_id)
);
create index questions_ticket_id_idx on questions (ticket_id);

-- The Run whose *needs you* Outcome moved the Ticket into its Status, until the Ticket moves again.
alter table tickets add column needs_you_run_id uuid references runs (id);
