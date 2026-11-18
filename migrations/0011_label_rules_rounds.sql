-- A Step's Label rule: Tickets pass it only with the Label (`requires`), or only without it (`skipped_by`).
-- A Ticket that doesn't pass gets no Run and moves on by the Step's default Outcome.
alter table steps add column label_rule_kind text check (label_rule_kind in ('requires', 'skipped_by'));
alter table steps add column label_rule_label text;
alter table steps add constraint steps_label_rule_whole check ((label_rule_kind is null) = (label_rule_label is null));

-- Cronk itself makes some Changes, such as moving a Ticket on past a Step it skipped: those have no Actor.
alter table changes drop constraint changes_one_actor;
alter table changes add constraint changes_at_most_one_actor check (num_nonnulls(actor_user_id, actor_agent_id) <= 1);
