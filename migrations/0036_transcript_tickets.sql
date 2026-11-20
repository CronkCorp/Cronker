-- A Transcript of a session that matched no Run, such as Claude Code connected by hand, links to each Ticket its
-- Cronk tool calls name, so it shows in their timelines. Each upload of the session replaces its links.
create table transcript_tickets (
  transcript_id uuid not null references transcripts (id) on delete cascade,
  ticket_id uuid not null references tickets (id),
  -- When the first call naming the Ticket was made, or the upload's time when the transcript didn't say.
  named_at timestamptz not null,
  -- Which of the Transcript's Tickets this is, in the order its calls first named them, from 1.
  position integer not null,
  primary key (transcript_id, ticket_id)
);
create index transcript_tickets_ticket_id_idx on transcript_tickets (ticket_id);
