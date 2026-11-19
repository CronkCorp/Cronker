-- A Ticket handed back to its Assignee by a Step's *needs you* Outcome, waiting in their Inbox until it moves
-- again. It no longer hangs on a Run: Cronk applies *needs you* past a round limit with no Run too, such as
-- for a failing check. `run_id` is the Run that finished with the Outcome, if one did; `question` is Cronk's
-- own Question, when it applied the Outcome past the Step's round limit (an Agent's Question is in `questions`).
create table needs_you (
  ticket_id uuid primary key,
  workspace_id uuid not null,
  run_id uuid references runs (id),
  outcome text not null,
  -- The Step whose Outcome it was, by its Status; null once that Status is removed.
  step_status_id uuid references statuses (id) on delete set null,
  step_status_name text not null,
  question text,
  foreign key (ticket_id, workspace_id) references tickets (id, workspace_id)
);

insert into needs_you (ticket_id, workspace_id, run_id, outcome, step_status_id, step_status_name, question)
select tickets.id, tickets.workspace_id, runs.id, runs.outcome, runs.status_id, runs.status_name,
  case when runs.question_by = 'cronk' then runs.question end
from tickets join runs on runs.id = tickets.needs_you_run_id;

alter table tickets drop column needs_you_run_id;
