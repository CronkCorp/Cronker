import { readFile } from "node:fs/promises";
import { Type, type Static } from "typebox";
import { repoPath } from "../paths.js";

/**
 * The Transcript hook: a script Cronk serves itself, so it always matches this Cronk, and the `settings.json`
 * snippet a User commits in each Repository to run it in Claude Code.
 */

/** Where Cronk serves the hook script. */
export const hookScriptPath = "/hooks/transcript.mjs";

/** The hook script as this Cronk ships it. */
export const readHookScript = (): Promise<Buffer> => readFile(repoPath("hooks/transcript.mjs"));

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
 * The hook as this Cronk's Users install it. Its command fetches the script once per session into the session's
 * temporary directory, runs it with this Cronk's address, and always exits 0 so it never fails the agent's turn.
 */
export function transcriptHook(publicUrl: URL): TranscriptHook {
  const cronk = publicUrl.origin;
  const script = `${cronk}${hookScriptPath}`;
  const command =
    `f="\${TMPDIR:-/tmp}/cronk-transcript-hook.mjs"; ` +
    `[ -s "$f" ] || { curl -fsS '${script}' -o "$f.part" && mv "$f.part" "$f"; }; ` +
    `CRONK_URL='${cronk}' node "$f"; exit 0`;
  const hook = { type: "command" as const, command, timeout: 60 };
  return {
    script,
    tokenVariable,
    settings: { hooks: { Stop: [{ hooks: [hook] }], PostToolUse: [{ matcher: "*", hooks: [{ ...hook, timeout: 15 }] }] } },
  };
}
