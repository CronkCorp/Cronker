-- Mentions (CRONK-11): the Ticket keys each Markdown text mentions, recorded when the text is saved, so a text links
-- its Mentions and a Ticket lists the texts mentioning it (Mentioned in). A text is a Ticket's description, a Comment,
-- a Document (a Report among them), a Term's definition or a Decision's body; for knowledge only its current Version
-- counts, so a save replaces the rows of the text it saves.
--
-- A Mention keeps the key as written and the key it names, by Project key and number, and is resolved to its
-- Ticket when read: a key naming no Ticket, such as one not yet created or one deleted, stays plain text. Later
-- kinds of target (Decisions, Terms, Artifacts) add their own columns and kinds.
create table mentions (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references workspaces (id),
  source_ticket_id uuid references tickets (id) on delete cascade,
  source_comment_id uuid references comments (id) on delete cascade,
  source_document_id uuid references documents (id) on delete cascade,
  -- Without foreign keys, so a test of an earlier migration can apply this one ahead of Terms and Decisions: deleting
  -- a Term removes its rows itself, and Decisions are never deleted.
  source_term_id uuid,
  source_decision_id uuid,
  target_kind text not null check (target_kind in ('ticket')),
  -- The Ticket key it names: its Project's key, in upper case as Projects keep it, and its number.
  project_key text not null,
  number integer not null,
  -- The key as written, such as `cronk-12`.
  written text not null,
  -- Its place among the text's Mentions, in order of first mention, counting from 0.
  position integer not null,
  constraint mentions_one_source check (
    num_nonnulls(source_ticket_id, source_comment_id, source_document_id, source_term_id, source_decision_id) = 1
  )
);
create index mentions_source_ticket_idx on mentions (source_ticket_id) where source_ticket_id is not null;
create index mentions_source_comment_idx on mentions (source_comment_id) where source_comment_id is not null;
create index mentions_source_document_idx on mentions (source_document_id) where source_document_id is not null;
create index mentions_source_term_idx on mentions (source_term_id) where source_term_id is not null;
create index mentions_source_decision_idx on mentions (source_decision_id) where source_decision_id is not null;
create index mentions_target_ticket_idx on mentions (workspace_id, project_key, number) where target_kind = 'ticket';

-- Work Cronk does once on its next start, in code, after the migrations that need it: here, indexing the texts
-- already stored, which takes parsing their Markdown. Each row is removed once its work is done.
create table pending_backfills (name text primary key);
insert into pending_backfills (name) values ('mentions');
