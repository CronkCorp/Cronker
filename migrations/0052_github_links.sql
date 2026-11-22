-- A signed-in User linking a GitHub account to themselves (CRONK-35): the OAuth state of the link they started,
-- by its hash, so GitHub's callback, which carries no sign-in cookie, links the account to that User only.
create table github_link_states (
  token_hash text primary key,
  user_id uuid not null references users (id) on delete cascade,
  created_at timestamptz not null,
  expires_at timestamptz not null
);
create index github_link_states_user_id_idx on github_link_states (user_id);
