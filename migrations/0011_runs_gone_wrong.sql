-- A Run with no word from it for its Workspace's lost-Run threshold is lost; one a User took its
-- Ticket away from (by moving, undelegating or re-delegating it) is stopped.
alter type run_state add value 'lost';
alter type run_state add value 'stopped';

-- When the Run's Agent last made a call naming the Run or its Ticket; none yet means since it started.
alter table runs add column last_call_at timestamptz;

-- How long a Run may go without a call naming it or its Ticket before it is lost. Set by the Workspace's Admins.
alter table workspaces add column lost_run_minutes integer not null default 30 check (lost_run_minutes > 0);
