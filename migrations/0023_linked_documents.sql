-- Linked Documents: a Ticket links Documents of its Project or of the Workspace, each once. A deleted Document
-- drops out of its links.
create table linked_documents (
  ticket_id uuid not null,
  document_id uuid not null,
  workspace_id uuid not null,
  -- Orders links made at the same instant in the order they were made.
  seq bigint generated always as identity,
  created_at timestamptz not null,
  primary key (ticket_id, document_id),
  foreign key (ticket_id, workspace_id) references tickets (id, workspace_id),
  foreign key (document_id, workspace_id) references documents (id, workspace_id) on delete cascade
);
create index linked_documents_document_id_idx on linked_documents (document_id);
