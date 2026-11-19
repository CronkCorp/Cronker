-- Marks the Comment Cronk writes when a failing check or a review requesting changes sends a
-- Ticket back, so a client can tell it from any other Comment by Cronk.
alter table comments add column sent_back boolean not null default false;
-- Until now Cronk wrote Comments only to send a Ticket back.
update comments set sent_back = true where actor_user_id is null and actor_agent_id is null;
