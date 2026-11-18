-- How many Runs a Runner keeps running at once; Tickets beyond it wait for a slot.
alter table runners add column run_limit integer not null default 2 check (run_limit >= 1);

-- When a Ticket entered its Status: among waiting Tickets of one Priority, the earliest gets a freed slot first.
alter table tickets add column status_entered_at timestamptz;
update tickets set status_entered_at = coalesce(
  (select max(changes.at) from changes where changes.ticket_id = tickets.id and changes.field = 'status'),
  tickets.created_at
);
alter table tickets alter column status_entered_at set not null;

-- A Ticket that needs a Run but hasn't got one: its Runner is full, or it is blocked.
alter table tickets add column waits_for_run boolean not null default false;
create index tickets_waiting_idx on tickets (delegate_id) where waits_for_run;
