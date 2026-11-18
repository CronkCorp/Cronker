-- Whether a Ticket first delegated in a Project takes Autonomous Delegation. Off by default.
alter table projects add column autonomous_delegation_default boolean not null default false;

-- Whether a Step may complete the Ticket itself. Null until a User sets it or the Ticket is first delegated,
-- when it takes its Project's default; a Sub-Ticket takes its parent's.
alter table tickets add column autonomous_delegation boolean;

-- Verification of a Ticket a Run completed: Unverified until a User Accepts it (Verified) or Reopens it.
-- Null for a Ticket no Run completed. `completed_from_status_id` is the Status of the Step that completed it,
-- where Reopen sends it back; null once that Status is removed.
create type verification as enum ('unverified', 'verified');
alter table tickets add column verification verification;
alter table tickets add column completed_from_status_id uuid references statuses (id) on delete set null;
