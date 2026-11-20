import { readFile } from "node:fs/promises";
import { Type, type Static } from "typebox";
import { repoPath } from "../paths.js";

/**
 * The Transcript hook: a script Cronk serves itself, so it always matches this Cronk, and the `settings.json`
 * snippet a User commits in each Repository to run it in Claude Code.
 */

/** Where Cronk serves the hook script, and where it ships it, from the repository's root. */
export const hookScriptPath = "/hooks/transcript.mjs";

/** The hook script as this Cronk ships it. */
export const readHookScript = (): Promise<Buffer> => readFile(repoPath(hookScriptPath.slice(1)));

/** How long Claude Code lets each hook run: an upload on `Stop` may take a while, a `PostToolUse` ping must not. */
const stopTimeoutSeconds = 60;
const postToolUseTimeoutSeconds = 15;

/** The variable of the cloud environment that holds the Transcript hook token. */
const tokenVariable = "CRONK_TOKEN";

const HookCommand = Type.Object({ type: Type.Literal("command"), command: Type.String(), timeout: Type.Integer() });

export const TranscriptHook = Type.Object({
  script: Type.String({ format: "uri", description: "Where this Cronk serves the hook script." }),
  tokenVariable: Type.String({ description: "The cloud environment's variable to hold the Transcript hook token." }),
  settings: Type.Object(
    {
      hooks: Type.Object({
        Stop: Type.Array(Type.Object({ hooks: Type.Array(HookCommand) })),
        PostToolUse: Type.Array(Type.Object({ matcher: Type.String(), hooks: Type.Array(HookCommand) })),
      }),
    },
    { description: "The `.claude/settings.json` snippet to commit in each Repository, with this Cronk's address in it." },
  ),
});
export type TranscriptHook = Static<typeof TranscriptHook>;

/**
 * The hook as this Cronk's Users install it. On `Stop` its command fetches the script afresh into the session's
 * temporary directory, so a machine that keeps it between sessions follows Cronk's upgrades; on `PostToolUse` it
 * runs the copy it has. Either way it runs the script with this Cronk's address and exits 0, never failing the
 * agent's turn.
 */
export function transcriptHook(publicUrl: URL): TranscriptHook {
  const cronk = publicUrl.origin;
  const script = `${cronk}${hookScriptPath}`;
  const file = `f="\${TMPDIR:-/tmp}/cronk-transcript-hook.mjs"; `;
  const fetchScript = `curl -fsS '${script}' -o "$f.part" && mv "$f.part" "$f"`;
  const run =
    `if [ -s "$f" ]; then CRONK_URL='${cronk}' node "$f"; ` +
    `else echo "Cronk's Transcript hook: couldn't fetch ${script}" >&2; fi; exit 0`;
  const onStop = `${file}${fetchScript}; ${run}`;
  const onToolUse = `${file}[ -s "$f" ] || { ${fetchScript}; }; ${run}`;
  return {
    script,
    tokenVariable,
    settings: {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: onStop, timeout: stopTimeoutSeconds }] }],
        PostToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: onToolUse, timeout: postToolUseTimeoutSeconds }] },
        ],
      },
    },
  };
}
