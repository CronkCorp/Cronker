-- Whether agents may merge Pull Requests of this Project's Tickets under Autonomous Delegation (ADR 0005).
-- Off by default; only an Admin changes it.
alter table projects add column agents_may_merge boolean not null default false;

-- A Step's kind: `ordinary`, or `merge`, which skips itself by its default Outcome unless the Ticket has
-- Autonomous Delegation and its Project has agents may merge on. Existing Steps stay ordinary, and existing
-- boards gain no Merge Status.
alter table steps add column kind text not null default 'ordinary' check (kind in ('ordinary', 'merge'));
