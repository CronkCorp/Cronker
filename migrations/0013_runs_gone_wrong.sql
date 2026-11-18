-- A Run with no call naming it or its Ticket (`runs.last_call_at`, or since it started) for its Workspace's
-- lost-Run threshold is lost; one a User took its Ticket away from (by moving, undelegating or
-- re-delegating it) is stopped.
alter type run_state add value 'lost';
alter type run_state add value 'stopped';

-- How long a Run may go without a call naming it or its Ticket before it is lost. Set by the Workspace's Admins.
alter table workspaces add column lost_run_minutes integer not null default 30 check (lost_run_minutes > 0);
