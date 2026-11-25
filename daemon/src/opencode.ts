import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClaimedRun } from "./api.js";
import type { MachineModel } from "./config.js";
import { keyOf } from "./models.js";
import type { ProgramOutput, RunProgram } from "./program.js";

/**
 * OpenCode V2, the program a Run on a Machine model runs as: `opencode run --standalone --format json`, configured
 * wholly inline through `OPENCODE_CONFIG_CONTENT`, in a home of the Run's own and with only the environment it needs.
 *
 * - The Machine model is the only provider, for the session and for helper requests such as its title, and a policy
 *   makes every other provider unusable however it became known.
 * - Cronk's MCP server is the only one, its tools given to the model directly (`codemode: false`), the Run's token
 *   read from an environment variable the config names, never from the arguments.
 * - Everything is denied, then reading, searching and editing inside the worktrees, Cronk's tools and a fixed set of
 *   commands are allowed. Paths outside the directory the Run works in are denied twice over: by `external_directory`,
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

/**
 * The commands a Run on a Machine model may run: `git`, and the read-only `gh` commands of a new Runner's allowlist.
 * The Runner's own allowlist doesn't apply yet.
 */
export const allowedCommands: readonly string[] = [
  "git *",
  "gh pr view *",
  "gh pr list *",
  "gh pr diff *",
  "gh pr checks *",
  "gh issue view *",
  "gh issue list *",
  "gh run view *",
  "gh run list *",
  "gh repo view *",
];

type Effect = "allow" | "deny";
interface Rule {
  action: string;
  resource: string;
  effect: Effect;
}

/**
 * The Run's permissions, in order; the last rule matching wins. Denied first, everything; then what is allowed; then
 * what is denied whatever came before: paths outside the worktrees, skills and removing OpenCode's worktrees.
 */
export function permissionsOf(): Rule[] {
  const allow = (action: string, resource = "*"): Rule => ({ action, resource, effect: "allow" });
  const deny = (action: string, resource = "*"): Rule => ({ action, resource, effect: "deny" });
  return [
    deny("*"),
    allow("read"),
    allow("glob"),
    allow("grep"),
    allow("edit"),
    allow(`${mcpServerName}_*`),
    ...allowedCommands.map((command) => allow("shell", command)),
    // A path outside the directory the Run works in is canonical and absolute; one inside it is relative.
    deny("external_directory"),
    deny("read", "/*"),
    deny("edit", "/*"),
    deny("skill"),
    deny("opencode_worktree_remove"),
  ];
}

/**
 * The Run's policies: hard denials that no permission rule, approval or other config lifts. Only the Machine model's
 * provider and Cronk's MCP server may be used, no skill, plugin or web search, and every tool check is denied but those
 * the permissions allow, which then decide.
 */
export function policiesOf(): Rule[] {
  const statement = (action: string, resource: string, effect: Effect): Rule => ({ action, resource, effect });
  const lifted = permissionsOf().filter((rule) => rule.effect === "allow");
  return [
    statement("provider.use", "*", "deny"),
    statement("provider.use", providerId, "allow"),
    statement("mcp.use", "*", "deny"),
    statement("mcp.use", mcpServerName, "allow"),
    statement("skill.use", "*", "deny"),
    statement("plugin.use", "*", "deny"),
    statement("websearch.use", "*", "deny"),
    statement("tool.use", "*", "deny"),
    ...lifted.map((rule) => statement("tool.use", `${rule.action}:${rule.resource}`, "allow")),
    ...["external_directory:*", "read:/*", "edit:/*", "skill:*", "opencode_worktree_remove:*"].map((resource) =>
      statement("tool.use", resource, "deny"),
    ),
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
    permissions: permissionsOf(),
    policies: policiesOf(),
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

/** What a line of `opencode run --format json` says, of what the daemon reads: every event names its session. */
function readOpenCodeLine(line: string): ProgramOutput {
  let event: { sessionID?: unknown };
  try {
    event = JSON.parse(line) as typeof event;
  } catch {
    return {};
  }
  // No cost: a made-up estimate would be added to the Run's totals.
  return typeof event?.sessionID === "string" && event.sessionID ? { sessionId: event.sessionID } : {};
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
    reader: () => readOpenCodeLine,
    // OpenCode keeps its sessions in a database, not a file: its events, as the daemon records them, are the transcript.
    records: true,
    transcript: async () => null,
  };
}
