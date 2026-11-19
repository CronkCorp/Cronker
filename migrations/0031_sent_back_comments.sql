-- Marks the Comment Cronk writes when a failing check or a review requesting changes sends a
-- Ticket back, so a client can tell it from any other Comment by Cronk.
alter table comments add column sent_back boolean not null default false;
