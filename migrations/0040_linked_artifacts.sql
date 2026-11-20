-- Linked Artifacts: a Ticket links Artifacts of its Project or of the Workspace, each once, as it links Documents. An
-- Artifact created during a Run is linked to the Run's Ticket. A deleted Artifact drops out of its links.
create table linked_artifacts (
  ticket_id uuid not null,
  artifact_id uuid not null,
  workspace_id uuid not null,
  -- Orders links made at the same instant in the order they were made.
  seq bigint generated always as identity,
  created_at timestamptz not null,
  primary key (ticket_id, artifact_id),
  foreign key (ticket_id, workspace_id) references tickets (id, workspace_id),
  foreign key (artifact_id, workspace_id) references artifacts (id, workspace_id) on delete cascade
);
create index linked_artifacts_artifact_id_idx on linked_artifacts (artifact_id);
