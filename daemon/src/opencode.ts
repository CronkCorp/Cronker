import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClaimedRun } from "./api.js";
import type { MachineModel } from "./config.js";
import { keyOf } from "./models.js";
import { capDeniedTools, type ProgramOutput, type RunProgram } from "./program.js";

/**
 * OpenCode V2, the program a Run on a Machine model runs as: `opencode run --standalone --format json`, configured
 * wholly inline through `OPENCODE_CONFIG_CONTENT`, in a home of the Run's own and with only the environment it needs.
 *
 * - The Machine model is the only provider, for the session and for helper requests such as its title, and a policy
 *   makes every other provider unusable however it became known.
 * - Cronk's MCP server is the only one, its tools given to the model directly (`codemode: false`), the Run's token
 *   read from an environment variable the config names, never from the arguments.
 * - Everything is denied, then reading, searching and editing inside the worktrees, Cronk's tools and the Runner's
 *   allowlist, translated, are allowed; a Run of a read-only Step is then denied edits. Paths outside the directory the Run works in are denied twice over: by `external_directory`,
 *   which OpenCode checks before a read or edit of one, and by denying absolute paths, as only those name one.
 * - Policies, which only ever tighten, deny the same again, so an agent's rules from elsewhere can't widen them.
 * - A Repository's own `opencode.json` isn't loaded, and would rank below the inline config if it were.
 */

/** The provider the Machine model goes by in the config. */
const providerId = "machine";
/** The name Cronk's MCP server goes by, so its tools are `cronk_<tool>`. */
const mcpServerName = "cronk";
/** The environment variables the config reads the Run's token and the model's key from. */
export const runTokenVariable = "CRONK_RUN_TOKEN";
export const modelKeyVariable = "CRONK_MODEL_KEY";

/** Cronk's own tools, as Claude Code's allowlist names them; always allowed, so never a rule left out. */
const cronkRule = /^mcp__cronk(__.*)?$/;

/** What a Runner's allowlist allows a Run on a Machine model, and the rules that don't apply to one. */
export interface Translation {
  /** Shell rules: `x *` for `Bash(x:*)`, `x` for `Bash(x)`. */
  commands: string[];
  webFetch: boolean;
  webSearch: boolean;
  /** The rules left out, as written: they would need widening to translate, or name a tool OpenCode doesn't have. */
  skipped: string[];
}

/**
 * The Runner's allowlist, Claude Code permission rules, translated for OpenCode. `Bash(x:*)` becomes a shell rule for
 * `x *` and `Bash(x)` an exact one; `WebFetch` and `WebSearch` allow their tools. Every other rule is left out, never
 * widened: `Edit`, `Read`, `WebFetch(domain:…)`, other MCP servers, a bare `Bash` and patterns OpenCode reads
 * differently, a `*` or `?` other than a trailing `:*`. Cronk's own tools are always allowed, so aren't left out.
 *
 * Cronk's server has a copy of the rules for the Runner's card (`server/runs/allowlist.ts`); a test keeps them alike.
 */
export function translateAllowlist(rules: readonly string[]): Translation {
  const translation: Translation = { commands: [], webFetch: false, webSearch: false, skipped: [] };
  for (const written of rules) {
    const rule = written.trim();
    if (!rule || cronkRule.test(rule)) continue;
    if (rule === "WebFetch") translation.webFetch = true;
    else if (rule === "WebSearch") translation.webSearch = true;
    else {
      const command = /^Bash\((.*)\)$/s.exec(rule)?.[1];
      const prefix = command?.endsWith(":*") ? command.slice(0, -2).trim() : undefined;
      const shell = prefix !== undefined ? prefix && `${prefix} *` : command?.trim();
      if (shell && !/[*?\n]/.test(shell.replace(/ \*$/, ""))) translation.commands.push(shell);
      else translation.skipped.push(rule);
    }
  }
  translation.commands = [...new Set(translation.commands)];
  translation.skipped = [...new Set(translation.skipped)];
  return translation;
}

type Effect = "allow" | "deny";
interface Rule {
  action: string;
  resource: string;
  effect: Effect;
}

/** OpenCode's tools that edit files, which a Run of a read-only Step is denied whatever else allows them. */
export const openCodeEditTools = ["edit", "write", "patch"];

/**
 * The Run's permissions, in order; the last rule matching wins. Denied first, everything; then what is allowed:
 * reading, searching and editing, Cronk's tools and the Runner's allowlist, translated; then what is denied whatever
 * came before: paths outside the worktrees, skills, removing OpenCode's worktrees and, for a read-only Step, edits.
 */
export function permissionsOf(allowlist: readonly string[], readOnly = false): Rule[] {
  const allow = (action: string, resource = "*"): Rule => ({ action, resource, effect: "allow" });
  const deny = (action: string, resource = "*"): Rule => ({ action, resource, effect: "deny" });
  const translation = translateAllowlist(allowlist);
  return [
    deny("*"),
    allow("read"),
    allow("glob"),
    allow("grep"),
    allow("edit"),
    allow(`${mcpServerName}_*`),
    ...translation.commands.map((command) => allow("shell", command)),
    ...(translation.webFetch ? [allow("webfetch")] : []),
    ...(translation.webSearch ? [allow("websearch")] : []),
    // A path outside the directory the Run works in is canonical and absolute; one inside it is relative.
    deny("external_directory"),
    deny("read", "/*"),
    deny("edit", "/*"),
    deny("skill"),
    deny("opencode_worktree_remove"),
    ...(readOnly ? openCodeEditTools.map((tool) => deny(tool)) : []),
  ];
}

/**
 * The Run's policies: hard denials that no permission rule, approval or other config lifts. Only the Machine model's
 * provider and Cronk's MCP server may be used, no skill or plugin, web search only when the allowlist allows it, and
 * every tool check is denied but those the permissions allow, which then decide.
 */
export function policiesOf(allowlist: readonly string[], readOnly = false): Rule[] {
  const statement = (action: string, resource: string, effect: Effect): Rule => ({ action, resource, effect });
  const permissions = permissionsOf(allowlist, readOnly);
  const lifted = permissions.filter((rule) => rule.effect === "allow");
  const webSearch = lifted.some((rule) => rule.action === "websearch");
  return [
    statement("provider.use", "*", "deny"),
    statement("provider.use", providerId, "allow"),
    statement("mcp.use", "*", "deny"),
    statement("mcp.use", mcpServerName, "allow"),
    statement("skill.use", "*", "deny"),
    statement("plugin.use", "*", "deny"),
    ...(webSearch ? [] : [statement("websearch.use", "*", "deny")]),
    statement("tool.use", "*", "deny"),
    ...lifted.map((rule) => statement("tool.use", `${rule.action}:${rule.resource}`, "allow")),
    ...[
      "external_directory:*",
      "read:/*",
      "edit:/*",
      "skill:*",
      "opencode_worktree_remove:*",
      ...(readOnly ? openCodeEditTools.map((tool) => `${tool}:*`) : []),
    ].map((resource) => statement("tool.use", resource, "deny")),
  ];
}

/** The model as `provider/model`, as OpenCode names it. */
export const modelReference = (model: MachineModel) => `${providerId}/${model.modelId}`;

/** OpenCode's whole config for a Run on the Machine model, as `OPENCODE_CONFIG_CONTENT` gives it. */
export function openCodeConfig(model: MachineModel, claimed: ClaimedRun, hasKey: boolean) {
  const reference = modelReference(model);
  return {
    $schema: "https://opencode.ai/config.json",
    model: reference,
    small_model: reference,
    providers: {
      [providerId]: {
        name: model.name,
        package: "@opencode/ai/providers/openai-compatible",
        settings: {
          baseURL: model.address,
          ...(hasKey ? { apiKey: `{env:${modelKeyVariable}}` } : {}),
        },
        models: {
          [model.modelId]: {
            limit: { context: model.contextSize, output: Math.min(8192, Math.floor(model.contextSize / 4)) },
          },
        },
      },
    },
    mcp: {
      servers: {
        [mcpServerName]: {
          type: "remote",
          url: claimed.mcpUrl,
          codemode: false,
          oauth: false,
          headers: { Authorization: `Bearer {env:${runTokenVariable}}` },
        },
      },
    },
    share: "disabled",
    update: "disable",
    autoupdate: false,
    permissions: permissionsOf(claimed.allowedTools, claimed.readOnly === true),
    policies: policiesOf(claimed.allowedTools, claimed.readOnly === true),
  };
}

/** The string a Run's OpenCode process carries in its title, by which a daemon starting again recognises it. */
export const titleOf = (runId: string) => `cronk-run ${runId}`;

/** The environment variables passed on from the daemon's own: the locale and the temporary directory. */
const passedOn = (name: string) => /^(LANG|LANGUAGE|LC_[A-Z_]+|TZ|TMPDIR|TMP|TEMP)$/.test(name);

/** The User's git identity, for the Run's commits, as the daemon's own environment gives it; empty when unset. */
function gitIdentity(env: NodeJS.ProcessEnv): Promise<{ name: string; email: string }> {
  const read = (key: string) =>
    new Promise<string>((resolve) =>
      execFile("git", ["config", "--get", key], { env }, (error, stdout) => resolve(error ? "" : stdout.trim())),
    );
  return Promise.all([read("user.name"), read("user.email")]).then(([name, email]) => ({ name, email }));
}

/** Quotes a value for a git config file. */
const gitValue = (value: string) => `"${value.replace(/[\\"]/g, (c) => `\\${c}`).replace(/\n/g, " ")}"`;

/** OpenCode's names for tools that older versions, and models, call otherwise. */
const toolAliases: Record<string, string> = { bash: "shell", apply_patch: "patch" };

/**
 * A tool call OpenCode denied, as a person reads it, or null for any other: a shell call as `Bash(<command>)`, the web
 * tools as `WebFetch` and `WebSearch`, as Claude Code's are, and any other by OpenCode's name for it, such as `edit`.
 * OpenCode ends a denied call as a `tool_use` event whose state is an error saying `Permission denied: <permission>`,
 * or that the permission needs an approval nobody is present to give.
 */
export function deniedToolOf(event: { type?: unknown; part?: unknown }): string | null {
  if (event.type !== "tool_use" || typeof event.part !== "object" || event.part === null) return null;
  const part = event.part as { tool?: unknown; state?: { status?: unknown; error?: unknown; input?: unknown } };
  const error = part.state?.error;
  if (part.state?.status !== "error" || typeof error !== "string" || !/^Permission (denied\b|\S+ needs approval)/.test(error))
    return null;
  if (typeof part.tool !== "string" || !part.tool.trim()) return null;
  const tool = part.tool.trim().toLowerCase();
  const name = toolAliases[tool] ?? tool;
  const command = (part.state.input as { command?: unknown } | undefined)?.command;
  if (name === "shell" && typeof command === "string") return `Bash(${command.trim()})`;
  if (name === "webfetch") return "WebFetch";
  if (name === "websearch") return "WebSearch";
  return name;
}

/**
 * A reader of one Run's `opencode run --format json` output, of what the daemon reads: every event names its session,
 * and the tool calls denied so far, all of them each time another is.
 */
function openCodeReader(): (line: string) => ProgramOutput {
  const denied: string[] = [];
  return (line) => {
    let event: { sessionID?: unknown; type?: unknown; part?: unknown };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      return {};
    }
    if (typeof event !== "object" || event === null) return {};
    // No cost: a made-up estimate would be added to the Run's totals.
    const said: ProgramOutput = typeof event.sessionID === "string" && event.sessionID ? { sessionId: event.sessionID } : {};
    const tool = deniedToolOf(event);
    if (tool !== null) {
      denied.push(tool);
      said.deniedTools = capDeniedTools(denied);
    }
    return said;
  };
}

/** OpenCode, running a Run on the Machine model, its executable `opencode` unless given. */
export function openCode(model: MachineModel, command = "opencode"): RunProgram {
  return {
    name: "opencode",
    command,
    async prepare(claimed, directory, env) {
      // The Run's home, outside the directory the agent works in: OpenCode's data, config and cache, git's and gh's.
      const home = join(directory, "home");
      const xdg = {
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local", "share"),
        XDG_STATE_HOME: join(home, ".local", "state"),
        XDG_CACHE_HOME: join(home, ".cache"),
      };
      for (const path of [home, ...Object.values(xdg)]) await mkdir(path, { recursive: true, mode: 0o700 });
      const identity = await gitIdentity(env.base);
      const gitconfig = [
        "[user]",
        ...(identity.name ? [`\tname = ${gitValue(identity.name)}`] : []),
        ...(identity.email ? [`\temail = ${gitValue(identity.email)}`] : []),
      ];
      if (gitconfig.length > 1) await writeFile(join(home, ".gitconfig"), `${gitconfig.join("\n")}\n`, { mode: 0o600 });

      const key = keyOf(model, env.base);
      const title = titleOf(claimed.runId);
      return {
        args: ["run", "--standalone", "--format", "json", "--model", modelReference(model), "--title", title, claimed.brief],
        identity: title,
        env: {
          ...Object.fromEntries(Object.entries(env.base).filter(([name]) => passedOn(name))),
          PATH: env.base.PATH,
          ...env.workspace,
          HOME: home,
          ...xdg,
          OPENCODE_CONFIG_CONTENT: JSON.stringify(openCodeConfig(model, claimed, key !== undefined)),
          // A Repository's own config can't change permissions or the server; nor are Claude Code's skills loaded.
          OPENCODE_DISABLE_PROJECT_CONFIG: "1",
          OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
          OPENCODE_DISABLE_AUTOUPDATE: "1",
          OPENCODE_DISABLE_MODELS_FETCH: "1",
          [runTokenVariable]: claimed.token,
          ...(key !== undefined ? { [modelKeyVariable]: key } : {}),
        },
      };
    },
    reader: openCodeReader,
    // OpenCode keeps its sessions in a database, not a file: its events, as the daemon records them, are the transcript.
    records: true,
    transcript: async () => null,
  };
}
