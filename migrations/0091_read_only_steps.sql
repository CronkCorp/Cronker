-- Whether a Step is read-only: its Runs on machine Runners can't change files. Off unless set; the default board's
-- Triage and Investigate have it on, and existing Projects' Steps on Statuses so named gain it too.
alter table steps add column read_only boolean not null default false;
update steps set read_only = true
  from statuses where statuses.id = steps.status_id and lower(statuses.name) in ('triage', 'investigate');

-- A Run keeps its Step's read-only setting as it stood when the Run started, as it keeps its Brief and model.
alter table runs add column read_only boolean not null default false;
