-- Full tokens 3 (CRONK-125): an Agent with a Full token queues merges, Cuts and Releases, and dismisses Questions as its
-- Owner would, each recorded as the Agent's.

-- A merge a Full Agent queued is its Agent's merge, completing as Unverified, but not Autonomous Delegation's: it waits
-- for no agents may merge, and turning that off leaves it queued.
alter table merge_queue add column by_full_token boolean not null default false;

-- Who cut or released a Release: a User, or an Agent with a Full token.
alter table releases add column cut_by_agent uuid references agents (id) on delete set null;
alter table releases add column released_by_agent uuid references agents (id) on delete set null;

-- Who dismissed a Question: a User, or an Agent with a Full token.
alter table questions add column dismissed_by_agent uuid references agents (id) on delete set null;

-- A Backport keeps whether a Full token queued the first Pull Request, so its own entry merges the same way.
alter table ticket_backports add column by_full_token boolean not null default false;
