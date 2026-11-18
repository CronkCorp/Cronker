-- Removing an Agent now undelegates its Tickets and stops its running Runs. Agents removed before that still
-- hold Tickets: undelegate them now, as their Owner's Change, and stop their running Runs. Only Cronk itself
-- can ask a Runner to stop a session or hand a freed slot on: those Runs could never call back anyway, and the
-- slots go to waiting Tickets when their Runner's next Run ends.
insert into changes (workspace_id, ticket_id, actor_user_id, at, field, from_value, to_value)
select tickets.workspace_id, tickets.id, agents.owner_id, now(), 'delegate',
  jsonb_build_object('id', agents.id, 'name', agents.name), null
from tickets join agents on agents.id = tickets.delegate_id
where agents.removed_at is not null;

update runs set state = 'stopped', ended_at = now(),
  end_reason = coalesce(owners.email, '@' || owners.github_login) || ' removed ' || agents.name || '.'
from agents join users owners on owners.id = agents.owner_id
where agents.id = runs.agent_id and agents.removed_at is not null and runs.state = 'running';

update tickets set delegate_id = null, waits_for_run = false
from agents
where agents.id = tickets.delegate_id and agents.removed_at is not null;
