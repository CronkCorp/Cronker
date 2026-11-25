-- Machine models (CRONK-156): a `local` Runner's mapping of model labels to Machine models, each `{label, model}`,
-- each label once ignoring case, none by default; and the Machine model a Run was claimed on, null for Claude, kept
-- as it was when the mapping changes later.
alter table runners
  add column machine_models jsonb not null default '[]';
alter table runs
  add column machine_model text;
