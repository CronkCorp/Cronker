import { readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClaimedRun } from "./api.js";

/**
 * The program a Run's agent runs as, behind the seam the daemon's Run lifecycle (worktrees, heartbeats, stops,
 * uploads, reporting its end, what a restarted daemon cleans up) calls: what to spawn, and what its output means.
 * Claude Code runs Runs on Claude; OpenCode (`opencode.ts`) runs Runs on a Machine model.
 */
export interface RunProgram {
  /** What the daemon calls it in what it prints and reports, such as `claude was killed by SIGTERM`. */
  name: string;
  /** The executable spawned, looked up on the `PATH` of the Run's environment. */
  command: string;
  /**
   * Writes what the program needs into the Run's scratch directory, outside the directory the agent works in, and
   * answers the arguments it runs with, the environment it runs with, from the daemon's own (`base`) and what the
   * Run's worktrees need (`workspace`), and its identity: a string unique to the Run that the process's command line
   * carries, so a daemon starting again kills only a process still running this Run.
   */
  prepare(
    claimed: ClaimedRun,
    directory: string,
    env: { base: NodeJS.ProcessEnv; workspace: NodeJS.ProcessEnv },
  ): Promise<{ args: string[]; identity: string; env: NodeJS.ProcessEnv }>;
  /** A reader of one Run's output, line by line, answering what each line said. */
  reader(): (line: string) => ProgramOutput;
  /** Where the transcript of the session is, once the program wrote it; null until then. */
  transcript(env: NodeJS.ProcessEnv, sessionId: string): Promise<string | null>;
}

/** What a line of a program's output said: each field only when the line said it. */
export interface ProgramOutput {
  /** The session's id. */
  sessionId?: string;
  /** What the session cost, in US dollars, as the program estimated it. */
  costUsd?: number;
  /** The tool calls the program denied, as a person reads them; replaces any said before. */
  deniedTools?: string[];
}

/** The name Cronk's MCP server goes by in a Run's `--mcp-config`, so `mcp__cronk` allows its tools. */
const mcpServerName = "cronk";

/** Cronk's own MCP tools, always allowed: without them the agent can't call `finish`. */
const cronkTools = `mcp__${mcpServerName}`;

/** Claude Code's tools that edit files, which a Run of a read-only Step is denied. */
export const claudeEditTools = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

/** Whether an allow rule names one of Claude Code's edit tools, such as `Edit` or `Write(src/**)`. */
const allowsEdits = (rule: string) =>
  claudeEditTools.includes(rule.trim().replace(/\(.*$/s, ""));

/**
 * The arguments `claude` runs a claimed Run with: edits accepted, and the Runner's allowlist, with Cronk's own tools
 * always in it, as the tools it may use without asking. In `-p` mode a tool call outside them is denied. A
 * Repository's committed Claude Code settings add their own allow rules, as Claude Code merges them.
 *
 * A Run of a read-only Step accepts no edits: the edit tools are disallowed, which wins over any allow rule, the
 * Repository's included, and dropped from the allowlist. Commands that write, such as `sed -i`, aren't stopped.
 */
export function claudeArguments(
  claimed: ClaimedRun,
  mcpConfigPath: string,
): string[] {
  const readOnly = claimed.readOnly === true;
  const allowed = [
    ...new Set([
      ...claimed.allowedTools.filter((rule) => !readOnly || !allowsEdits(rule)),
      cronkTools,
    ]),
  ];
  return [
    "-p",
    claimed.brief,
    "--model",
    claimed.modelId ?? "",
    "--output-format",
    "stream-json",
    // `-p` refuses `stream-json` output without it.
    "--verbose",
    "--mcp-config",
    mcpConfigPath,
    "--permission-mode",
    readOnly ? "default" : "acceptEdits",
    ...(readOnly ? ["--disallowedTools", ...claudeEditTools] : []),
    // Last, one rule per argument: the flag takes every argument after it.
    "--allowedTools",
    ...allowed,
  ];
}

/** At most this many denied tools are reported with a Run's end, each at most `deniedToolLength` characters. */
const deniedToolsMax = 20;
const deniedToolLength = 200;

/**
 * The tool calls Claude Code denied, from its `result` message's `permission_denials`, as a person reads them: a
 * Bash call as `Bash(<command>)`, any other by its tool name.
 */
export function deniedTools(message: {
  permission_denials?: unknown;
}): string[] {
  if (!Array.isArray(message.permission_denials)) return [];
  const names = message.permission_denials.flatMap(
    (denial: { tool_name?: unknown; tool_input?: { command?: unknown } }) => {
      if (typeof denial?.tool_name !== "string" || !denial.tool_name.trim())
        return [];
      const command = denial.tool_input?.command;
      const name =
        denial.tool_name === "Bash" && typeof command === "string"
          ? `Bash(${command.trim()})`
          : denial.tool_name.trim();
      return [
        name.length > deniedToolLength
          ? `${name.slice(0, deniedToolLength - 1)}…`
          : name,
      ];
    },
  );
  return [...new Set(names)].slice(0, deniedToolsMax);
}

/**
 * Where Claude Code writes a session's transcript: `<config dir>/projects/<encoded cwd>/<session id>.jsonl`, the config
 * directory being `$CLAUDE_CONFIG_DIR` or `~/.claude`. The encoded cwd is looked up rather than computed, as a
 * symlinked temporary directory (macOS's `/var`) makes it differ from the path the daemon knows.
 */
export async function findTranscript(
  env: NodeJS.ProcessEnv,
  sessionId: string,
): Promise<string | null> {
  const projects = join(
    env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude"),
    "projects",
  );
  const directories = await readdir(projects).catch(() => [] as string[]);
  for (const directory of directories) {
    const path = join(projects, directory, `${sessionId}.jsonl`);
    if (
      await stat(path).then(
        (s) => s.isFile(),
        () => false,
      )
    )
      return path;
  }
  return null;
}

/** What a line of `claude -p --output-format stream-json` says, of what the daemon reads. */
function readClaudeLine(line: string): ProgramOutput {
  let message: {
    type?: unknown;
    subtype?: unknown;
    session_id?: unknown;
    total_cost_usd?: unknown;
    permission_denials?: unknown;
  };
  try {
    message = JSON.parse(line) as typeof message;
  } catch {
    return {};
  }
  const said: ProgramOutput = {};
  if (
    message.type === "system" &&
    message.subtype === "init" &&
    typeof message.session_id === "string"
  )
    said.sessionId = message.session_id;
  if (message.type === "result") {
    if (
      typeof message.total_cost_usd === "number" &&
      Number.isFinite(message.total_cost_usd)
    )
      said.costUsd = Math.max(0, message.total_cost_usd);
    said.deniedTools = deniedTools(message);
  }
  return said;
}

/** Claude Code, run as `claude -p` with Cronk's MCP server, its executable `claude` unless given. */
export function claudeCode(command = "claude"): RunProgram {
  return {
    name: "claude",
    command,
    async prepare(claimed, directory, env) {
      // The Run's token goes in a file only its User reads, outside the directory the agent works in, never in argv.
      const mcpConfigPath = join(directory, "mcp.json");
      const mcpConfig = {
        mcpServers: {
          [mcpServerName]: {
            type: "http",
            url: claimed.mcpUrl,
            headers: { authorization: `Bearer ${claimed.token}` },
          },
        },
      };
      await writeFile(mcpConfigPath, JSON.stringify(mcpConfig), {
        mode: 0o600,
      });
      return {
        args: claudeArguments(claimed, mcpConfigPath),
        identity: mcpConfigPath,
        // The User's own environment, signed in to Claude as they are.
        env: { ...env.base, ...env.workspace },
      };
    },
    reader: () => readClaudeLine,
    transcript: findTranscript,
  };
}
