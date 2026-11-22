-- Concise Reports (CRONK-43): a Project setting that adds a rule to every Brief asking Runs to keep their Reports short.
alter table projects add column concise_reports boolean not null default false;
