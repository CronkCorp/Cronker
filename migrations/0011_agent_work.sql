-- An Agent changes a Ticket only during its running Run on it: each of its Changes names that Run.
alter table changes add column run_id uuid references runs (id);
