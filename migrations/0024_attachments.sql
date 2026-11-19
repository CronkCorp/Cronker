-- Attachments: plain files attached to exactly one Ticket, Document or Comment of a Workspace, by an Actor. Their
-- bytes are kept by Cronk's Attachment storage (a directory from configuration), named by id; only what describes
-- them is kept here.
alter table comments add constraint comments_id_workspace_key unique (id, workspace_id);

create table attachments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id),
  ticket_id uuid,
  document_id uuid,
  comment_id uuid,
  name text not null,
  media_type text not null,
  size bigint not null check (size >= 0),
  actor_user_id uuid references users (id),
  actor_agent_id uuid,
  created_at timestamptz not null,
  foreign key (ticket_id, workspace_id) references tickets (id, workspace_id),
  foreign key (document_id, workspace_id) references documents (id, workspace_id),
  foreign key (comment_id, workspace_id) references comments (id, workspace_id),
  foreign key (actor_agent_id, workspace_id) references agents (id, workspace_id),
  constraint attachments_one_owner check (num_nonnulls(ticket_id, document_id, comment_id) = 1),
  constraint attachments_one_actor check (num_nonnulls(actor_user_id, actor_agent_id) = 1)
);
create index attachments_ticket_idx on attachments (ticket_id, created_at) where ticket_id is not null;
create index attachments_document_idx on attachments (document_id, created_at) where document_id is not null;
create index attachments_comment_idx on attachments (comment_id, created_at) where comment_id is not null;
