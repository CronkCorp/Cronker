-- An Agent changes a Ticket only during its running Run on it: each of its Changes names that Run.
alter table changes add column run_id uuid references runs (id);

-- Reports: Markdown a Run writes on its Ticket, listed with the Ticket for Users and later Runs to read.
-- Lets a Report insist its Run is of its own Ticket.
alter table runs add constraint runs_id_ticket_key unique (id, ticket_id);

create table reports (
  id uuid primary key default gen_random_uuid(),
  -- Orders Reports written at the same instant in the order they were written.
  seq bigint generated always as identity,
  workspace_id uuid not null references workspaces (id),
  ticket_id uuid not null,
  run_id uuid not null,
  agent_id uuid not null,
  title text not null,
  body text not null,
  created_at timestamptz not null,
  foreign key (ticket_id, workspace_id) references tickets (id, workspace_id),
  foreign key (run_id, ticket_id) references runs (id, ticket_id),
  foreign key (agent_id, workspace_id) references agents (id, workspace_id)
);
create index reports_ticket_id_idx on reports (ticket_id, seq);

-- A Report a Run finished with is one of its Ticket's Reports, titled after the Run's Step.
insert into reports (workspace_id, ticket_id, run_id, agent_id, title, body, created_at)
select workspace_id, ticket_id, id, agent_id, status_name || ' report', report, ended_at
from runs where report is not null order by seq;
alter table runs drop column report;

-- When a Run's Agent last called Cronk naming the Run or its Ticket; none before its first call.
alter table runs add column last_call_at timestamptz;
