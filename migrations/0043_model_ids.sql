-- Each Workspace's model ids: for each model label, as Steps use them, the exact model id a Runner setup gives
-- the routine for that label. Admins change them; labels are matched ignoring case, like trigger labels.
create table workspace_model_ids (
  workspace_id uuid not null references workspaces (id) on delete cascade,
  -- The model label as the Admin typed it.
  label text not null,
  model_id text not null
);
create unique index workspace_model_ids_key on workspace_model_ids (workspace_id, lower(label));

-- The defaults: the latest model of each family. Every Workspace starts with them, those created from now on
-- through the trigger below, and those that already exist here.
create function seed_workspace_model_ids() returns trigger language plpgsql as $$
begin
  insert into workspace_model_ids (workspace_id, label, model_id)
  values (new.id, 'haiku', 'claude-haiku-5-5'), (new.id, 'sonnet', 'claude-sonnet-5-5'), (new.id, 'opus', 'claude-opus-5-5');
  return null;
end;
$$;
create trigger workspaces_seed_model_ids after insert on workspaces for each row execute function seed_workspace_model_ids();

insert into workspace_model_ids (workspace_id, label, model_id)
select workspaces.id, defaults.label, defaults.model_id
from workspaces
cross join (values ('haiku', 'claude-haiku-5-5'), ('sonnet', 'claude-sonnet-5-5'), ('opus', 'claude-opus-5-5')) as defaults (label, model_id);
