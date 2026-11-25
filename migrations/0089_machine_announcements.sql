-- Machine models (CRONK-154): what each Machine's daemon last announced it offers, kept while it is offline and
-- forgotten on unpairing. A daemon that never announces keeps the defaults: it runs Claude and offers no Machine
-- models. Each Machine model is `{name, limit, up}`; addresses, keys and model ids stay on the Machine.
alter table machines
  add column announces_claude boolean not null default true,
  add column announced_models jsonb not null default '[]';
