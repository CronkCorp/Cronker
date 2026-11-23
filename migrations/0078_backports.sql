-- Backporting (CRONK-116): a Ticket of a cut Release whose Pull Request merges into the default branch after the Cut
-- waits in its Merge Status for a Backport, a second Pull Request carrying the merge onto `release/<name>`. The row
-- holds the merge to backport, the Merge Status it waits in (leaving it drops the row, as for queue entries) and who
-- queued the first Pull Request, so the Backport joins the release branch's queue as theirs; both are null for a merge
-- on GitHub outside the queue. `backporting` while a Run of the Merge Step backports it; `backported` once that Run
-- finished with *backported*, waiting for the Backport to link and join the queue.
create table ticket_backports (
  ticket_id uuid primary key references tickets (id) on delete cascade,
  workspace_id uuid not null references workspaces (id),
  release_id uuid not null references releases (id) on delete cascade,
  status_id uuid not null references statuses (id) on delete cascade,
  pull_request_id bigint not null references pull_requests (id) on delete cascade,
  queued_by_user_id uuid references users (id) on delete set null,
  queued_by_agent_id uuid references agents (id) on delete set null,
  state text not null default 'backporting' check (state in ('backporting', 'backported')),
  created_at timestamptz not null
);

-- Existing Merge Steps get the *backported* Outcome, which leaves the Ticket in the Merge Status, last among their
-- Outcomes; their Briefs stay as each Project wrote them.
insert into outcomes (step_id, project_id, position, name, status_id, is_default, needs_you, counts_as_round)
select steps.id, steps.project_id, (select coalesce(max(position), -1) + 1 from outcomes o where o.step_id = steps.id),
  'backported', steps.status_id, false, false, false
from steps
where steps.kind = 'merge'
  and not exists (select from outcomes o where o.step_id = steps.id and lower(o.name) = 'backported');
