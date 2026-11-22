-- claude.ai names one Claude Code on the web session both `cse_…` and `session_…`: its routine fire now answers
-- `cse_…`, while the Transcript hook sends `session_…`, so no upload or alive ping found its Run, and long Runs
-- became lost. Cronk now keeps every such id as `cse_…` (`server/runs/session-ids.ts`). This rewrites the ids it
-- holds, then gives each Transcript of no Run the Run its session now names, as an upload would have.
update runs set session_id = 'cse_' || substr(session_id, 9)
 where session_id like 'session\_%' and length(session_id) > 8;

-- A session uploaded under both names keeps the `cse_…` Transcript it already has.
update transcripts t set session_id = 'cse_' || substr(t.session_id, 9)
 where t.session_id like 'session\_%' and length(t.session_id) > 8
   and not exists (
     select 1 from transcripts o where o.agent_id = t.agent_id and o.session_id = 'cse_' || substr(t.session_id, 9)
   );

-- A Run's Transcript links to its Run, not to the Tickets its tool calls name (`uploadTranscript`).
with linked as (
  update transcripts t set run_id = r.id
    from runs r
   where t.run_id is null and r.agent_id = t.agent_id and r.session_id = t.session_id
     and r.seq = (select max(seq) from runs latest where latest.agent_id = t.agent_id and latest.session_id = t.session_id)
  returning t.id
)
delete from transcript_tickets where transcript_id in (select id from linked);
