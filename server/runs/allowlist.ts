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

/**
 * The rules of an allowlist that don't apply to Runs on Machine models, as written, for the Runner's card. The daemon
 * translates the allowlist for OpenCode (`translateAllowlist` in `daemon/src/opencode.ts`, which can't share code with
 * the server; a test keeps the two alike): `Bash(x:*)` and `Bash(x)` become shell rules and `WebFetch` and `WebSearch`
 * allow their tools. Every other rule is left out, never widened: `Edit`, `Read`, `WebFetch(domain:…)`, other MCP
 * servers, a bare `Bash` and patterns OpenCode reads differently, a `*` or `?` other than a trailing `:*`. Cronk's own
 * tools are always allowed, so aren't listed.
 */
export function notForMachineModels(rules: readonly string[]): string[] {
  const skipped = rules.flatMap((written) => {
    const rule = written.trim();
    if (!rule || /^mcp__cronk(__.*)?$/.test(rule) || rule === "WebFetch" || rule === "WebSearch") return [];
    const command = /^Bash\((.*)\)$/s.exec(rule)?.[1];
    const prefix = command?.endsWith(":*") ? command.slice(0, -2).trim() : undefined;
    const shell = prefix !== undefined ? prefix && `${prefix} *` : command?.trim();
    return shell && !/[*?\n]/.test(shell.replace(/ \*$/, "")) ? [] : [rule];
  });
  return [...new Set(skipped)];
}
