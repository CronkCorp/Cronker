-- The Agent a Project's new Tickets start delegated to when they start delegated (CRONK-174), instead of their
-- creator's first Agent. Null for the creator's first Agent; a removed Agent, or one without Write in the Project, is
-- skipped at creation and the creator's first Agent takes the Ticket.
alter table projects add column default_agent_id uuid references agents(id) on delete set null;
