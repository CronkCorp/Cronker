/**
 * The allowlist a new `local` Runner starts with: git, common package managers and test runners, and Cronk's MCP
 * tools, as Claude Code permission rules. Its User widens or narrows it on the Runner's card, or resets it to this.
 */
export const defaultAllowedTools: readonly string[] = [
  "Bash(git:*)",
  "Bash(npm:*)",
  "Bash(npx:*)",
  "Bash(pnpm:*)",
  "Bash(yarn:*)",
  "Bash(node:*)",
  "Bash(pytest:*)",
  "Bash(cargo:*)",
  "Bash(go:*)",
  "Bash(make:*)",
  "mcp__cronk",
];
