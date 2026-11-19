-- Reports become Documents: a Report is a Document a Run writes on its Ticket, of the Ticket's Project, listed
-- with the Ticket instead of in a page tree, so it has no parent and no place among siblings.
alter table documents
  add column ticket_id uuid,
  add column run_id uuid,
  -- Orders Reports written at the same instant in the order they were written.
  add column seq bigint generated always as identity,
  alter column position drop not null,
  add foreign key (ticket_id, workspace_id) references tickets (id, workspace_id),
  add foreign key (run_id, ticket_id) references runs (id, ticket_id),
  add constraint documents_report_of_run check ((ticket_id is null) = (run_id is null)),
  add constraint documents_report_outside_tree check (
    (ticket_id is null) = (position is not null) and (ticket_id is null or parent_id is null)
  );
create index documents_ticket_id_idx on documents (ticket_id, seq) where ticket_id is not null;

-- Each milestone 1 Report becomes a Document with one Version by its Agent, keeping its id and time.
insert into documents (id, workspace_id, project_id, ticket_id, run_id, version, created_at)
select reports.id, reports.workspace_id, tickets.project_id, reports.ticket_id, reports.run_id, 1, reports.created_at
from reports join tickets on tickets.id = reports.ticket_id
order by reports.seq;
insert into document_versions (document_id, number, workspace_id, title, body, actor_agent_id, saved_at)
select id, 1, workspace_id, title, body, agent_id, created_at from reports;

drop table reports;
