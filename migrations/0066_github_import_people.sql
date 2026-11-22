-- The issues importer brings Comments and people (CRONK-87). An imported Comment whose GitHub author has no User
-- keeps the author's login and no actor, which tells it apart from Cronk's own Comments. An import keeps the logins
-- of the authors it found no User for, for its summary.
alter table comments add column github_author_login text;
alter table comments add constraint comments_github_author_check
  check (github_author_login is null or (actor_user_id is null and actor_agent_id is null and not sent_back));
alter table github_imports add column unmatched_authors text[] not null default '{}';
