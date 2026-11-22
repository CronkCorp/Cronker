-- Redactions (CRONK-74): a string a User redacted from a Transcript the scrubbing missed. Cronk keeps it only to apply
-- it again, to what it holds and to every later upload or fetch of the session; the API never returns it, and a
-- redaction is never removed.
create table transcript_redactions (
  id uuid primary key default gen_random_uuid(),
  transcript_id uuid not null references transcripts (id) on delete cascade,
  text text not null,
  added_by uuid not null references users (id),
  added_at timestamptz not null
);
create index transcript_redactions_transcript_idx on transcript_redactions (transcript_id, added_at);
