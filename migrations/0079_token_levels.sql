-- Token access (CRONK-123): a token is Read, Write or Full. Today's `full` tokens act under today's Agent rules, which
-- is Write now, so they keep exactly what they may do; Full lifts the Agent-specific rules and is only picked by hand.
alter table agent_tokens drop constraint agent_tokens_access_check;
update agent_tokens set access = 'write' where access = 'full';
alter table agent_tokens add constraint agent_tokens_access_check check (access in ('read', 'write', 'full'));
alter table agent_tokens alter column access set default 'write';

-- An OAuth approval carries the level the Owner picked, so the tokens traded for its code, and their refreshes, keep it.
alter table oauth_requests add column access text not null default 'write' check (access in ('write', 'full'));
