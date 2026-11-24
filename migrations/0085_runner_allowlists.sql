-- The allowlist of a `local` Runner (CRONK-144): the tools its Runs may use without asking, passed to `claude` as
-- `--allowedTools`. Null for other kinds. Existing `local` Runners get the default a new one gets.
alter table runners add column allowed_tools text[];
update runners set allowed_tools = array[
  'Bash(git:*)', 'Bash(npm:*)', 'Bash(npx:*)', 'Bash(pnpm:*)', 'Bash(yarn:*)', 'Bash(node:*)',
  'Bash(pytest:*)', 'Bash(cargo:*)', 'Bash(go:*)', 'Bash(make:*)', 'mcp__cronk'
] where kind = 'local';
