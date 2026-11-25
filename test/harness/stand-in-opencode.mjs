// A stand-in for OpenCode V2's `opencode` CLI, put on the daemon's PATH by tests (seam 2) behind a wrapper script that
// sets its own $STAND_IN_OPENCODE_* variables, as the daemon passes on only the environment a Run needs. It records how
// it was run to the JSON-lines file in $STAND_IN_OPENCODE_LOG: its arguments, working directory, pid, environment (but
// its own variables), the config in $OPENCODE_CONFIG_CONTENT and, run in a git worktree, the branch, the password git's
// credential helpers give for $STAND_IN_OPENCODE_CREDENTIAL_URL, what `gh` printed, the git identity and the
// Repository's own config files it holds. It prints `--format json` events, each naming its session: a step's start and
// the agent's text, and, finishing, a command run, one failed and the call to `finish`. Then, as
// $STAND_IN_OPENCODE_MODE says: `finish`es the Run named
// in its Brief through the MCP server and headers its config gives, `{env:…}` read as OpenCode does, and exits 0;
// `exit:<code>` exits with that code without finishing; `denied` ends shell, edit, write, patch and webfetch calls as
// OpenCode 2.4 ends a call its permissions deny, an allowed call and a failed one among them, and exits 0 without
// finishing; `hang`s until killed; or `hang-hard`s, ignoring SIGTERM, until SIGKILL. Run with `--session <id>`, as a
// resume is, it says that session's id and runs in the mode after `-then-`: `exit-then-finish` exits 0 without
// finishing, then finishes on a resume; `linger-then-hang` exits 0 after 800 ms, then hangs on a resume, recording when
// SIGTERM came. `exit-on-term` hangs until SIGTERM, then exits 0. `retry` says nothing but `session.status` retry
// events; `retry-mixed` says another event among them every 150 ms. Each log line carries when it started,
// `startedAt`; one with `terminatedAt` records when a hanging run got SIGTERM.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "null");
const fromEnv = (text) => text.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => process.env[name] ?? "");
const run = (command, commandArgs, input) => {
  try {
    return execFileSync(command, commandArgs, { input, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

let repository = null;
const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch !== null) {
  const credentialUrl = process.env.STAND_IN_OPENCODE_CREDENTIAL_URL;
  const credential = credentialUrl ? run("git", ["credential", "fill"], `url=${credentialUrl}\n\n`) : "";
  repository = {
    branch,
    password: /^password=(.*)$/m.exec(credential ?? "")?.[1] ?? null,
    gh: run("gh", ["pr", "view"]),
    gitName: run("git", ["config", "user.name"]),
    // The Repository's own config files there, which OpenCode is told not to load.
    configFiles: ["opencode.json", ".claude/settings.json"].filter((path) => existsSync(path)),
  };
}
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("STAND_IN_OPENCODE_")));
appendFileSync(
  process.env.STAND_IN_OPENCODE_LOG,
  `${JSON.stringify({ args, cwd: process.cwd(), pid: process.pid, startedAt: Date.now(), env, config, repository })}\n`,
);

const resuming = args.includes("--session");
const sessionID = resuming ? args[args.indexOf("--session") + 1] : `ses_stand_in_${process.pid}`;
const say = (type, more = {}) => process.stdout.write(`${JSON.stringify({ type, timestamp: Date.now(), sessionID, ...more })}\n`);
say("step_start");
say("text", { part: { type: "text", text: "Looking at the Ticket." } });

const given = process.env.STAND_IN_OPENCODE_MODE ?? "finish";
const [first, then] = given.split("-then-");
const mode = then === undefined ? given : resuming ? then : first === "linger" ? "linger" : "exit:0";
if (mode === "linger") {
  setTimeout(() => process.exit(0), 800);
} else if (mode === "hang" && then !== undefined) {
  process.on("SIGTERM", () => {
    appendFileSync(process.env.STAND_IN_OPENCODE_LOG, `${JSON.stringify({ pid: process.pid, terminatedAt: Date.now() })}\n`);
    process.exit(143);
  });
  setInterval(() => {}, 1000);
} else if (mode === "exit-on-term") {
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1000);
} else if (mode === "retry" || mode === "retry-mixed") {
  let attempt = 0;
  setInterval(() => say("session.status", { status: { type: "retry", attempt: ++attempt, message: "Connection refused" } }), 50);
  if (mode === "retry-mixed") setInterval(() => say("text", { part: { type: "text", text: "thinking" } }), 150);
} else if (mode === "hang" || mode === "hang-hard") {
  if (mode === "hang-hard") process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else if (mode === "denied") {
  const call = (tool, input, error) =>
    say("tool_use", {
      part: {
        type: "tool",
        tool,
        state: error === undefined ? { status: "completed", input, output: "" } : { status: "error", input, error },
      },
    });
  call("shell", { command: "git status" });
  call("shell", { command: "npm publish" }, "Permission denied: shell");
  call("bash", { command: "rm -rf build" }, "Permission denied: shell");
  call("shell", { command: "npm test" }, "Command failed with exit code 1");
  call("edit", { filePath: "README.md" }, "Permission denied: edit");
  call("write", { filePath: "NEW.md" }, "Permission denied: edit");
  call("apply_patch", { patchText: "*** Begin Patch" }, "Permission edit needs approval, and nobody is present to give it");
  call("webfetch", { url: "https://example.com" }, "Permission denied: webfetch");
  call("shell", { command: "npm publish" }, "Permission denied: shell");
  say("step_finish");
  process.exit(0);
} else if (mode.startsWith("exit:")) {
  process.stderr.write("stand-in opencode gave up\n");
  process.exit(Number(mode.slice(5)));
} else {
  const tool = (callID, name, state) => say("tool_use", { part: { type: "tool", callID, tool: name, state } });
  tool("call_ls", "bash", { status: "completed", input: { command: "ls", description: "List the files" }, output: "README.md\n" });
  tool("call_curl", "bash", { status: "error", input: { command: "curl https://example.com" }, error: "The user has specified a rule which prevents you from using this specific tool call." });
  const brief = args.at(-1);
  const runId = /Run id is ([0-9a-f-]{36})/.exec(brief)[1];
  const server = config.mcp.servers.cronk;
  const headers = Object.fromEntries(Object.entries(server.headers).map(([name, value]) => [name, fromEnv(value)]));
  const rpc = async (id, method, params) => {
    const response = await fetch(server.url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    return response.json();
  };
  await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stand-in-opencode", version: "0" } });
  const result = await rpc(2, "tools/call", { name: "finish", arguments: { run: runId, outcome: "ready" } });
  tool("call_finish", "cronk_finish", { status: result.result?.isError ? "error" : "completed", input: { run: runId, outcome: "ready" }, output: "Finished." });
  say("step_finish");
  process.exit(0);
}
