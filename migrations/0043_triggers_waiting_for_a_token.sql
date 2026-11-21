-- A subscription Runner's trigger may be saved with only its trigger id, waiting for its token: Runs needing it
-- can't start until the User pastes the token, which is sealed under CRONK_SECRET_KEY like any other.
alter table runner_triggers alter column token_sealed drop not null;
