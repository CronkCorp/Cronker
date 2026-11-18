-- A Step's Label rule: Tickets pass it only with the Label (`requires`), or only without it (`skipped_by`).
-- A Ticket that doesn't pass gets no Run and moves on by the Step's default Outcome.
alter table steps add column label_rule_kind text check (label_rule_kind in ('requires', 'skipped_by'));
alter table steps add column label_rule_label text;
alter table steps add constraint steps_label_rule_whole check ((label_rule_kind is null) = (label_rule_label is null));

-- Cronk itself makes some Changes, such as moving a Ticket on past a Step it skipped: those have no Actor.
alter table changes drop constraint changes_one_actor;
alter table changes add constraint changes_at_most_one_actor check (num_nonnulls(actor_user_id, actor_agent_id) <= 1);

-- Rounds per Ticket per Step: how many times the Step's Runs chose an Outcome that counts as a round.
-- A User moving the Ticket by hand clears its counts; removing the Step removes its counts.
create table round_counts (
  workspace_id uuid not null references workspaces (id),
  ticket_id uuid not null,
  step_id uuid not null references steps (id) on delete cascade,
  count integer not null check (count > 0),
  primary key (ticket_id, step_id),
  foreign key (ticket_id, workspace_id) references tickets (id, workspace_id)
);
create index round_counts_step_id_idx on round_counts (step_id);

-- Who asked a Run's Question: its Agent, or Cronk when a round Outcome met the Step's round limit.
alter table runs add column question_by text check (question_by in ('agent', 'cronk'));
alter table runs add constraint runs_question_asked check ((question is null) = (question_by is null));
