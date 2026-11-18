-- Whether a Ticket first delegated in a Project takes Autonomous Delegation. Off by default.
alter table projects add column autonomous_delegation_default boolean not null default false;

-- Whether a Step may complete the Ticket itself. Null until a User sets it or the Ticket is first delegated,
-- when it takes its Project's default; a Sub-Ticket takes its parent's.
alter table tickets add column autonomous_delegation boolean;
