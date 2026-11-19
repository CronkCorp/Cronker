-- Who merged a Pull Request, as GitHub reported it: the account's login, for showing. Null until
-- it is merged, or when GitHub named nobody.
alter table pull_requests add column merged_by_login text;

-- Whether a merge of a Pull Request completes the Tickets it links. On by default; off, merges
-- only update the Pull Request's state.
alter table projects add column pull_request_automation boolean not null default true;

-- A Ticket completed by work no Step produced, such as a merge of a Pull Request a User opened:
-- Reopen leaves it where it is instead of sending it back to a Step's Status. Read only while
-- the Ticket is Unverified; every completion sets it.
alter table tickets add column completed_without_step boolean not null default false;
