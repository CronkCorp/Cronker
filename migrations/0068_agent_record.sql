-- The Agent Record reads what each Agent did, newest first, from what Cronk already keeps.
create index runs_agent_id_idx on runs (agent_id, started_at desc);
create index changes_actor_agent_idx on changes (actor_agent_id, at desc) where actor_agent_id is not null;
create index comments_actor_agent_idx on comments (actor_agent_id, created_at desc) where actor_agent_id is not null;
create index document_versions_actor_agent_idx on document_versions (actor_agent_id, saved_at desc) where actor_agent_id is not null;
create index term_versions_actor_agent_idx on term_versions (actor_agent_id, saved_at desc) where actor_agent_id is not null;
create index decision_versions_actor_agent_idx on decision_versions (actor_agent_id, saved_at desc) where actor_agent_id is not null;
create index artifact_versions_actor_agent_idx on artifact_versions (actor_agent_id, saved_at desc) where actor_agent_id is not null;
