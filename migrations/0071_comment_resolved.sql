-- Resolving a Document thread (CRONK-68): a User resolves a thread on a Document through its first Comment, which
-- records when and by whom; unresolving clears both.
alter table comments add column resolved_at timestamptz;
alter table comments add column resolved_by_user_id uuid references users (id);
alter table comments add constraint comments_resolved_together check ((resolved_at is null) = (resolved_by_user_id is null));
alter table comments add constraint comments_resolved_thread
  check (resolved_at is null or (document_id is not null and reply_to_id is null));
