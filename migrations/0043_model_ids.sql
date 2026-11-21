-- Each Workspace's model ids: for each model label, as Steps use them, the exact model id a Runner setup gives
-- the routine for that label. Admins change them; labels are matched ignoring case, like trigger labels.
create table workspace_model_ids (
  workspace_id uuid not null references workspaces (id) on delete cascade,
  -- The model label as the Admin typed it.
  label text not null,
  model_id text not null
);
create unique index workspace_model_ids_key on workspace_model_ids (workspace_id, lower(label));

-- The defaults: the latest model of each family. A later Cronk adopting newer models replaces this function.
create function default_model_ids() returns table (label text, model_id text) language sql immutable as $$
  values ('haiku', 'claude-haiku-5-5'), ('sonnet', 'claude-sonnet-5-5'), ('opus', 'claude-opus-5-5')
$$;

-- Every Workspace starts with the defaults: those created from now on through this trigger, wherever Cronk creates
-- them (setup or the API), and those that already exist below.
create function seed_workspace_model_ids() returns trigger language plpgsql as $$
begin
  insert into workspace_model_ids (workspace_id, label, model_id) select new.id, d.label, d.model_id from default_model_ids() d;
  return null;
end;
$$;
create trigger workspaces_seed_model_ids after insert on workspaces for each row execute function seed_workspace_model_ids();

insert into workspace_model_ids (workspace_id, label, model_id)
select workspaces.id, d.label, d.model_id from workspaces cross join default_model_ids() d;
