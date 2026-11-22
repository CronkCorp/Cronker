-- The User's settings page is at `/account`, so no Workspace slug may be `account` (`server/workspaces/slugs.ts`).
-- A Workspace that already had it gets `-2`, `-3` and so on, as 0044 gave slugs.
do $$
declare
  n integer := 1;
  candidate text := 'account';
begin
  if exists (select 1 from workspaces where slug = 'account') then
    loop
      n := n + 1;
      candidate := 'account-' || n;
      exit when not exists (select 1 from workspaces where slug = candidate);
    end loop;
    update workspaces set slug = candidate where slug = 'account';
  end if;
end $$;
