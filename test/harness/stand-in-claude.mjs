// A stand-in for Claude Code's `claude` CLI, put on the daemon's PATH by tests (seam 2). It records how it was run
// to the JSON-lines file in $STAND_IN_CLAUDE_LOG, prints a `stream-json` session start, and then, as
// $STAND_IN_CLAUDE_MODE says: `finish`es the Run named in its Brief through Cronk's MCP server with the token from
// its `--mcp-config` and exits 0; `exit:<code>` exits with that code without finishing; `hang`s until killed; or
// `hang-hard`s, ignoring SIGTERM, until SIGKILL.
import { appendFileSync, readFileSync, statSync } from "node:fs";

const args = process.argv.slice(2);
const after = (flag) => args[args.indexOf(flag) + 1];
const mcpConfigPath = after("--mcp-config");
const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf8"));
appendFileSync(
  process.env.STAND_IN_CLAUDE_LOG,
  `${JSON.stringify({ pid: process.pid, args, cwd: process.cwd(), mcpConfig, mcpConfigMode: statSync(mcpConfigPath).mode & 0o777 })}\n`,
);

const sessionId = `stand-in-${process.pid}`;
const say = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
say({ type: "system", subtype: "init", session_id: sessionId, model: after("--model") });

const mode = process.env.STAND_IN_CLAUDE_MODE ?? "finish";
if (mode === "hang" || mode === "hang-hard") {
  if (mode === "hang-hard") process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else if (mode.startsWith("exit:")) {
  process.stderr.write("stand-in claude gave up\n");
  process.exit(Number(mode.slice(5)));
} else {
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
  const result = await rpc(2, "tools/call", { name: "finish", arguments: { run: runId, outcome: "ready" } });
  say({ type: "assistant", message: { content: [{ type: "text", text: JSON.stringify(result) }] }, session_id: sessionId });
  say({ type: "result", subtype: "success", session_id: sessionId, total_cost_usd: 0.0123, is_error: Boolean(result.result?.isError) });
  process.exit(0);
}
