// A stand-in for Claude Code's `claude` CLI, put on the daemon's PATH by tests (seam 2). It records how it was run
// to the JSON-lines file in $STAND_IN_CLAUDE_LOG, prints a `stream-json` session start, and then, as
// $STAND_IN_CLAUDE_MODE says: `finish`es the Run named in its Brief through Cronk's MCP server with the token from
// its `--mcp-config` and exits 0; `wait-finish` does so once the file `$STAND_IN_CLAUDE_LOG.go` exists; `exit:<code>`
// exits with that code without finishing; `denied:<command>` ends its turn on a Bash call to that command outside its
// allowed tools, reporting it in `permission_denials`, and exits 0 without finishing; `edit-denied:<path>` does the
// same for an Edit of that file; `write:<path>` writes that file as Claude Code's Write tool would, allowed only inside
// its working directory or a directory its `--add-dir`s name, then finishes, and otherwise ends its turn on the Write
// denied, as `edit-denied` does; `hang`s until killed; or
// `hang-hard`s, ignoring SIGTERM, until SIGKILL. A comma-separated $STAND_IN_CLAUDE_MODE gives each run its own mode, in
// the order they run, the last one for any further runs. $STAND_IN_CLAUDE_OUTCOME is the Outcome it finishes with
// (`ready` when unset), and with $STAND_IN_CLAUDE_LINGER_MS set it waits that long after finishing before it exits, as
// Claude Code does while it writes its closing message. With $CLAUDE_CONFIG_DIR set it writes its session's transcript where
// Claude Code does, a line as it starts and another as it finishes.
// Run in a git worktree, it also records the branch and commit it is on and the password git's credential helpers give
// for the URL in $STAND_IN_CLAUDE_CREDENTIAL_URL; with $STAND_IN_CLAUDE_PUSH set, it commits a file and pushes it to
// that branch before finishing. Asked `auth status`, it says it is signed in.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
// `claude auth status`, as the daemon's preflight asks before `run`: signed in.
if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write(`${JSON.stringify({ loggedIn: true })}\n`);
  process.exit(0);
}
const after = (flag) => args[args.indexOf(flag) + 1];
const mcpConfigPath = after("--mcp-config");
const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf8"));
const git = (...gitArgs) => execFileSync("git", gitArgs, { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim();
let repository = null;
try {
  const credentialUrl = process.env.STAND_IN_CLAUDE_CREDENTIAL_URL;
  const credential = credentialUrl
    ? execFileSync("git", ["credential", "fill"], { input: `url=${credentialUrl}\n\n`, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] })
    : "";
  repository = {
    branch: git("rev-parse", "--abbrev-ref", "HEAD"),
    head: git("rev-parse", "HEAD"),
    password: /^password=(.*)$/m.exec(credential)?.[1] ?? null,
  };
} catch {
  // Not in a git worktree.
}
// Which run this is, counting from 0, by the runs logged before it.
const runIndex = readFileSync(process.env.STAND_IN_CLAUDE_LOG, "utf8").split("\n").filter(Boolean).length;
appendFileSync(
  process.env.STAND_IN_CLAUDE_LOG,
  `${JSON.stringify({ args, cwd: process.cwd(), pid: process.pid, mcpConfig, mcpConfigMode: statSync(mcpConfigPath).mode & 0o777, repository })}\n`,
);
const pushTo = process.env.STAND_IN_CLAUDE_PUSH;
if (pushTo) {
  writeFileSync("stand-in.txt", `pushed by ${process.pid}\n`);
  git("add", "stand-in.txt");
  git("-c", "user.name=stand-in", "-c", "user.email=stand-in@example.com", "commit", "--quiet", "-m", "Stand-in work");
  git("push", "--quiet", "origin", `HEAD:refs/heads/${pushTo}`);
}

const sessionId = `stand-in-${process.pid}`;
const say = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
say({ type: "system", subtype: "init", session_id: sessionId, model: after("--model") });

const transcript = (() => {
  if (!process.env.CLAUDE_CONFIG_DIR) return null;
  const directory = join(process.env.CLAUDE_CONFIG_DIR, "projects", process.cwd().replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(directory, { recursive: true });
  return join(directory, `${sessionId}.jsonl`);
})();
const write = (type, content) => {
  if (!transcript) return;
  const line = { type, uuid: `${type}-${Date.now()}`, timestamp: new Date().toISOString(), sessionId, message: { role: type, content } };
  appendFileSync(transcript, `${JSON.stringify(line)}\n`);
};
write("user", after("-p"));

const modes = (process.env.STAND_IN_CLAUDE_MODE ?? "finish").split(",");
/** Whether Claude Code's Write tool may write the file: inside its working directories, with edits accepted. */
function writable(file) {
  const directories = [process.cwd(), ...args.flatMap((arg, i) => (args[i - 1] === "--add-dir" ? [arg] : []))];
  const acceptEdits = after("--permission-mode") === "acceptEdits";
  return acceptEdits && directories.some((directory) => file === directory || file.startsWith(`${directory}/`));
}
const mode = modes[Math.min(runIndex, modes.length - 1)];
if (mode === "wait-finish") {
  while (!existsSync(`${process.env.STAND_IN_CLAUDE_LOG}.go`)) await new Promise((resolve) => setTimeout(resolve, 20));
}
if (mode === "hang" || mode === "hang-hard") {
  if (mode === "hang-hard") process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else if (mode.startsWith("denied:")) {
  const command = mode.slice(7);
  say({
    type: "result",
    subtype: "success",
    session_id: sessionId,
    is_error: false,
    permission_denials: [{ tool_name: "Bash", tool_use_id: "toolu_stand_in", tool_input: { command } }],
  });
  process.exit(0);
} else if (mode.startsWith("edit-denied:")) {
  const file_path = mode.slice(12);
  say({
    type: "result",
    subtype: "success",
    session_id: sessionId,
    is_error: false,
    permission_denials: [{ tool_name: "Edit", tool_use_id: "toolu_stand_in", tool_input: { file_path } }],
  });
  process.exit(0);
} else if (mode.startsWith("write:") && !writable(mode.slice(6))) {
  say({
    type: "result",
    subtype: "success",
    session_id: sessionId,
    is_error: false,
    permission_denials: [{ tool_name: "Write", tool_use_id: "toolu_stand_in", tool_input: { file_path: mode.slice(6) } }],
  });
  process.exit(0);
} else if (mode.startsWith("exit:")) {
  process.stderr.write("stand-in claude gave up\n");
  process.exit(Number(mode.slice(5)));
} else {
  if (mode.startsWith("write:")) writeFileSync(mode.slice(6), "written by the stand-in claude\n");
  const runId = /Run id is ([0-9a-f-]{36})/.exec(after("-p"))[1];
  const server = mcpConfig.mcpServers.cronk;
  const rpc = async (id, method, params) => {
    const response = await fetch(server.url, {
      method: "POST",
      headers: { ...server.headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    return response.json();
  };
  await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stand-in-claude", version: "0" } });
  const result = await rpc(2, "tools/call", { name: "finish", arguments: { run: runId, outcome: process.env.STAND_IN_CLAUDE_OUTCOME ?? "ready" } });
  say({ type: "assistant", message: { content: [{ type: "text", text: JSON.stringify(result) }] }, session_id: sessionId });
  write("assistant", [{ type: "text", text: "Finished." }]);
  say({ type: "result", subtype: "success", session_id: sessionId, total_cost_usd: 1.37, is_error: Boolean(result.result?.isError) });
  const linger = Number(process.env.STAND_IN_CLAUDE_LINGER_MS ?? 0);
  if (linger > 0) await new Promise((resolve) => setTimeout(resolve, linger));
  process.exit(0);
}
