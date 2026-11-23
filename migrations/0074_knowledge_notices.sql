-- New knowledge (CRONK-110): each Decision, Term, Document or Artifact an Agent creates waits as one New knowledge item
-- in one User's Inbox, the Assignee of the Ticket of the Run it was created in, or else the Agent's Owner, fixed when it
-- is created, as for a Discovered Ticket. It waits until that User dismisses it, or, for a Decision, until its status
-- leaves proposed. It goes with its knowledge when that is deleted. Reports are Documents on their Tickets and make none.
create table knowledge_notices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  agent_id uuid not null references agents (id) on delete cascade,
  run_id uuid references runs (id) on delete set null,
  decision_id uuid references decisions (id) on delete cascade,
  term_id uuid references terms (id) on delete cascade,
  document_id uuid references documents (id) on delete cascade,
  artifact_id uuid references artifacts (id) on delete cascade,
  created_at timestamptz not null,
  dismissed_at timestamptz,
  check (num_nonnulls(decision_id, term_id, document_id, artifact_id) = 1)
);
create index knowledge_notices_waiting_idx on knowledge_notices (workspace_id, user_id) where dismissed_at is null;
create index knowledge_notices_decision_idx on knowledge_notices (decision_id) where decision_id is not null;
