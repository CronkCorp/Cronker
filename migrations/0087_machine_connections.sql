-- Offline Machines (CRONK-141): how many event streams each Machine's daemon holds open now, and when its last one
-- closed. A `local` Runner none of whose Machines is connected is offline: its Tickets wait rather than start. Streams
-- don't outlive the server, so it resets the counts when it starts.
alter table machines
  add column connections integer not null default 0 check (connections >= 0),
  add column disconnected_at timestamptz;
