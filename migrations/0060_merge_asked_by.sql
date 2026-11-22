-- Who asked Cronk to merge each Pull Request, and how the merge completes its Tickets (CRONK-92), from just before
-- Cronk asks GitHub until Cronk records the merge or GitHub refuses it, so GitHub's own delivery of the merge,
-- arriving first, records it as theirs: `{"actor": {...}, "completeAs": "verified" | "unverified"}`. It replaces the
-- Run that asked, which only an Agent's Merge Run could be; a merge already asked for keeps its Run.
alter table pull_requests add column merge_asked_by jsonb;
update pull_requests set merge_asked_by = jsonb_build_object(
    'actor', jsonb_build_object('kind', 'agent', 'agentId', runs.agent_id, 'runId', runs.id, 'workspaceId', runs.workspace_id),
    'completeAs', 'unverified')
  from runs where runs.id = pull_requests.merge_asked_by_run_id;
alter table pull_requests drop column merge_asked_by_run_id;
