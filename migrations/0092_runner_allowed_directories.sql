-- The directories outside its worktree a `local` Runner's Runs may read and write (CRONK-172), such as `/tmp`, passed
-- to `claude` as `--add-dir`. Empty by default, so none is opened unless its Owner lists it; null for other kinds.
alter table runners add column allowed_directories text[];
update runners set allowed_directories = '{}' where kind = 'local';
