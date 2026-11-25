/**
 * The allowlist a new `local` Runner starts with, as Claude Code permission rules. Its User widens or narrows it on the
 * Runner's card, or resets it to this; existing Runners keep their own list.
 *
 * - git, common package managers, build tools and test runners, and language runtimes (`node`, `python`), which run
 *   the Repository's own code anyway.
 * - Text filters and read-only inspection a Run pipes output through: `head`, `tail`, `sed`, `jq` and the like.
 * - Read-only `gh` commands only. Whole `gh`, and `gh api`, could merge Pull Requests or change a repository's
 *   settings outside Cronk's merge rules (ADR 0007): merges go through `merge_pull_request`.
 * - Cronk's MCP tools.
 *
 * Left out on purpose: `find` (`-exec`, `-delete`), `awk` (`system()`), `curl` and `wget`, `rm`, `chmod`, `docker`,
 * `ssh` and `pip`. A User adds them per Runner where a Repository needs them.
 */
export const defaultAllowedTools: readonly string[] = [
  "Bash(git:*)",
  "Bash(npm:*)",
  "Bash(npx:*)",
  "Bash(pnpm:*)",
  "Bash(yarn:*)",
  "Bash(node:*)",
  "Bash(python:*)",
  "Bash(python3:*)",
  "Bash(pytest:*)",
  "Bash(cargo:*)",
  "Bash(go:*)",
  "Bash(dotnet:*)",
  "Bash(make:*)",
  "Bash(cat:*)",
  "Bash(ls:*)",
  "Bash(head:*)",
  "Bash(tail:*)",
  "Bash(wc:*)",
  "Bash(sort:*)",
  "Bash(uniq:*)",
  "Bash(cut:*)",
  "Bash(tr:*)",
  "Bash(sed:*)",
  "Bash(grep:*)",
  "Bash(rg:*)",
  "Bash(diff:*)",
  "Bash(jq:*)",
  "Bash(gh pr view:*)",
  "Bash(gh pr list:*)",
  "Bash(gh pr diff:*)",
  "Bash(gh pr checks:*)",
  "Bash(gh issue view:*)",
  "Bash(gh issue list:*)",
  "Bash(gh run view:*)",
  "Bash(gh run list:*)",
  "Bash(gh repo view:*)",
  "mcp__cronk",
];
