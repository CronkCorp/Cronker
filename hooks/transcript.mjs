// Cronk's Transcript hook, served by Cronk at /hooks/transcript.mjs so it always matches the Cronk it talks to.
//
// Claude Code runs it as a hook, with the hook's input as JSON on stdin:
// - on `Stop` it uploads the session's whole transcript, the JSONL file as it is, which also tells Cronk the
//   session ended its turn: a Run whose session then calls nothing for a few minutes fails;
// - on `PostToolUse` it only tells Cronk the session's Run is alive, on the first tool call after a `Stop` and then
//   at most once every 5 minutes, so a long turn that calls nothing in Cronk doesn't become lost.
// It reads Cronk's address from CRONK_URL and an Agent token from CRONK_TOKEN. In Claude Code on the web it names
// the session as Cronk knows it (CLAUDE_CODE_REMOTE_SESSION_ID's `cse_…` becomes `session_…`); elsewhere by
// Claude Code's own session id.
//
// It never fails the agent's turn: whatever goes wrong is written to stderr, and it exits 0.
// Plain Node.js 18+, no dependencies.

import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** How often, at most, a `PostToolUse` tells Cronk the Run is alive. */
const aliveEveryMs = 5 * 60 * 1000;
/** How long an upload may take; Claude Code gives a hook 60 seconds. */
const uploadTimeoutMs = 45 * 1000;
const aliveTimeoutMs = 10 * 1000;

async function main() {
  const input = JSON.parse(await readStdin());
  const cronkUrl = process.env.CRONK_URL?.replace(/\/+$/, "");
  const token = process.env.CRONK_TOKEN;
  if (!cronkUrl) throw new Error("CRONK_URL is not set: it should be Cronk's address.");
  if (!token) throw new Error("CRONK_TOKEN is not set: add the Transcript hook token to the environment's variables.");
  const sessionId = sessionOf(input);
  const session = `${cronkUrl}/api/transcripts/sessions/${encodeURIComponent(sessionId)}`;
  const headers = { authorization: `Bearer ${token}` };

  if (input.hook_event_name === "PostToolUse") {
    if (!(await aliveIsDue(sessionId))) return;
    // Noted first, so a Cronk that can't be reached isn't asked again on every tool call.
    await noteAlive(sessionId);
    await send(`${session}/alive`, { method: "POST", headers, signal: AbortSignal.timeout(aliveTimeoutMs) });
    return;
  }

  if (typeof input.transcript_path !== "string") throw new Error("The hook's input names no transcript_path.");
  const transcript = await readFile(input.transcript_path);
  await send(session, {
    method: "PUT",
    headers: { ...headers, "content-type": "application/x-ndjson" },
    body: transcript,
    signal: AbortSignal.timeout(uploadTimeoutMs),
  });
  // The upload tells Cronk the session ended its turn: the first tool call of a next turn, such as one woken by
  // activity on its pull request, says at once that it is working again, or Cronk fails the Run.
  await forgetAlive(sessionId);
}

/** The session as Cronk knows it: the claude.ai session a Run's Runner returned, or Claude Code's own id. */
function sessionOf(input) {
  const remote = process.env.CLAUDE_CODE_REMOTE_SESSION_ID;
  if (remote) return remote.replace(/^cse_/, "session_");
  if (typeof input.session_id === "string" && input.session_id) return input.session_id;
  throw new Error("The hook's input names no session_id.");
}

/** Sends a request to Cronk, throwing with Cronk's own reason when it refuses. */
async function send(url, init) {
  const response = await fetch(url, init);
  if (response.ok) return;
  const body = await response.text();
  let reason = body.slice(0, 500);
  try {
    reason = JSON.parse(body).error?.message ?? reason;
  } catch {
    // Not Cronk's JSON, such as a proxy's page: the start of the body is reason enough.
  }
  throw new Error(`Cronk answered ${response.status}: ${reason}`);
}

/** Where the hook keeps, per session, when it last told Cronk the session's Run is alive. */
const aliveDir = () => join(tmpdir(), "cronk-transcript-hook");

/** The file whose modification time says when this session last told Cronk its Run is alive. */
const aliveFile = (sessionId) => join(aliveDir(), `${sessionId.replace(/[^\w.-]/g, "_")}.alive`);

async function aliveIsDue(sessionId) {
  try {
    return Date.now() - (await stat(aliveFile(sessionId))).mtimeMs >= aliveEveryMs;
  } catch {
    return true;
  }
}

async function noteAlive(sessionId) {
  const file = aliveFile(sessionId);
  await mkdir(aliveDir(), { recursive: true });
  await writeFile(file, "");
  const now = new Date();
  await utimes(file, now, now);
}

async function forgetAlive(sessionId) {
  await rm(aliveFile(sessionId), { force: true });
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

try {
  await main();
} catch (error) {
  process.stderr.write(`Cronk's Transcript hook: ${error instanceof Error ? error.message : String(error)}\n`);
}
process.exit(0);
