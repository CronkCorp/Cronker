-- A Discovered Ticket: one an Agent filed outside its own Ticket's Sub-Tickets. It records the filing Agent, and
-- the Ticket and Run it was filed from, if any. It waits in its Assignee's Inbox, and the Agent may edit it and
-- add blocks from it, until a User delegates, moves or dismisses it.
alter table tickets add column discovered_by_agent_id uuid;
alter table tickets add foreign key (discovered_by_agent_id, workspace_id) references agents (id, workspace_id);
alter table tickets add column discovered_from_ticket_id uuid;
alter table tickets add foreign key (discovered_from_ticket_id, workspace_id) references tickets (id, workspace_id);
alter table tickets add column discovered_in_run_id uuid references runs (id);
alter table tickets add column discovery_waits boolean not null default false;
alter table tickets add constraint tickets_discovery_by_agent
  check (discovered_by_agent_id is not null or (discovered_from_ticket_id is null and discovered_in_run_id is null
    and not discovery_waits));
create index tickets_discovery_waits_idx on tickets (assignee_id) where discovery_waits;

-- A Relation is made by a User or, from its Discovered Ticket, by an Agent; never both.
alter table relations alter column created_by drop not null;
alter table relations add column created_by_agent_id uuid;
alter table relations add foreign key (created_by_agent_id, workspace_id) references agents (id, workspace_id);
alter table relations add constraint relations_one_creator check (num_nonnulls(created_by, created_by_agent_id) = 1);
