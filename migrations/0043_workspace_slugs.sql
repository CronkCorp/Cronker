-- Workspace slugs: each Workspace's name in its web addresses (`/<slug>/tickets/RP-12`), unique across the
-- installation and never changed once set. Existing Workspaces get one from their name, oldest first: lower case
-- letters and digits with single dashes between words, accents and apostrophes dropped, at most 40 characters,
-- `workspace` for a name with none of those; a slug already taken, or a word the web client's own pages use, gets
-- `-2`, `-3` and so on in place of its last characters, keeping it within 40. Cronk makes new ones the same way
-- (`server/workspaces/slugs.ts`), and the slugs in the addresses of Documents, Artifacts and Transcripts from their
-- titles with the same function.
create function slug_of(title text) returns text language sql immutable parallel safe return
  trim(both '-' from left(trim(both '-' from regexp_replace(
    regexp_replace(lower(normalize(title, NFKD)), '[\u0300-\u036f''’]', '', 'g'), '[^a-z0-9]+', '-', 'g')), 40));

alter table workspaces add column slug text;

do $$
declare
  workspace record;
  base text;
  candidate text;
  n integer;
begin
  for workspace in select id, name from workspaces order by created_at, id loop
    base := slug_of(workspace.name);
    if base = '' then base := 'workspace'; end if;
    candidate := base;
    n := 1;
    while candidate in ('workspaces', 'projects', 'tickets', 'documents', 'terms', 'decisions', 'artifacts',
        'transcripts', 'password', 'github', 'runners', 'link', 'connect', 'api', 'assets', 'mcp', 'oauth', 'hooks')
      or exists (select 1 from workspaces taken where taken.slug = candidate) loop
      n := n + 1;
      candidate := trim(trailing '-' from left(base, 40 - length('-' || n))) || '-' || n;
    end loop;
    update workspaces set slug = candidate where id = workspace.id;
  end loop;
end $$;

alter table workspaces alter column slug set not null;
alter table workspaces add constraint workspaces_slug_key unique (slug);
alter table workspaces add constraint workspaces_slug_shape check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
