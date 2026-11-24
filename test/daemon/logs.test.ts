import { appendFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  endRunRecord,
  isRunning,
  pruneRunRecords,
  readRunRecords,
  writeRunRecord,
  type RunRecord,
} from "../../daemon/src/history.js";
import { daemonLogCommand, followRun, followRunning, renderLine, resolveRun, summarize } from "../../daemon/src/logs.js";

/** `cronk-runner logs` on its own: rendering Claude Code's JSONL, finding Runs by key, and following their files. */

let home: string;
let historyDir: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cronk-runner-logs-"));
  historyDir = join(home, "runs", "history");
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const line = (type: string, content: unknown) => JSON.stringify({ type, message: { role: type, content } });

/** A pid no process has: the highest a Linux kernel hands out is lower. */
const gonePid = 2 ** 22 + 1;

const record = (fields: Partial<RunRecord> = {}): RunRecord => ({
  runId: "11111111-1111-4111-8111-111111111111",
  ticketKey: "CRONK-12",
  cronkUrl: "https://cronk.example.com",
  pid: process.pid,
  sessionId: null,
  transcriptPath: null,
  startedAt: "2026-11-24T10:00:00.000Z",
  endedAt: null,
  ...fields,
});

describe("renderLine", () => {
  test("prints the agent's text, one line per tool call with its summary, and failed results", () => {
    expect(renderLine(line("assistant", [{ type: "text", text: "Looking.\nAt the code." }]))).toEqual([
      "Looking.",
      "At the code.",
    ]);
    expect(
      renderLine(
        line("assistant", [
          { type: "thinking", thinking: "hidden" },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "git status\n  --short", description: "Show status" } },
          { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/a.ts" } },
          { type: "tool_use", id: "t3", name: "TodoWrite", input: {} },
        ]),
      ),
    ).toEqual(["[Bash] Show status", "[Read] /a.ts", "[TodoWrite]"]);
    expect(
      renderLine(
        line("user", [
          { type: "tool_result", tool_use_id: "t1", content: "fine" },
          { type: "tool_result", tool_use_id: "t2", is_error: true, content: [{ type: "text", text: "No such\nfile" }] },
        ]),
      ),
    ).toEqual(["[error] No such file"]);
  });

  test("leaves out the Brief, other kinds of line and lines that aren't JSON", () => {
    expect(renderLine(line("user", "You are an agent working on CRONK-12"))).toEqual([]);
    expect(renderLine(JSON.stringify({ type: "summary", summary: "x" }))).toEqual([]);
    expect(renderLine('{"type":"assistant","mess')).toEqual([]);
    expect(renderLine(JSON.stringify({ type: "system", content: "Compacted" }))).toEqual(["[system] Compacted"]);
  });
});

test("summarize picks a tool input's telling field, then its first text, then its JSON, on one line of at most 200", () => {
  expect(summarize({ pattern: "foo", path: "src" })).toBe("src");
  expect(summarize({ other: 3, name: "x" })).toBe("x");
  expect(summarize({ n: 3 })).toBe('{"n":3}');
  expect(summarize({ command: "a".repeat(300) })).toHaveLength(200);
  expect(summarize(undefined)).toBe("");
});

test("resolveRun finds a Run by its id, or the newest of its Ticket's, ignoring case", () => {
  const older = record({ runId: "a", startedAt: "2026-11-20T00:00:00.000Z" });
  const newer = record({ runId: "b", startedAt: "2026-11-21T00:00:00.000Z" });
  expect(resolveRun([older, newer], "cronk-12")?.runId).toBe("b");
  expect(resolveRun([older, newer], "a")?.runId).toBe("a");
  expect(resolveRun([older, newer], "CRONK-13")).toBeUndefined();
});

describe("Run records", () => {
  test("are running until ended or their process is gone, and pruned a week after they ended", async () => {
    const now = Date.parse("2026-11-24T12:00:00.000Z");
    await writeRunRecord(historyDir, record({ runId: "running" }));
    await writeRunRecord(historyDir, record({ runId: "recent", endedAt: "2026-11-20T00:00:00.000Z" }));
    await writeRunRecord(historyDir, record({ runId: "old", endedAt: "2026-11-10T00:00:00.000Z" }));
    await writeRunRecord(historyDir, record({ runId: "orphan", pid: gonePid, startedAt: "2026-11-01T00:00:00.000Z" }));
    await endRunRecord(historyDir, "recent", new Date(now));

    const records = await readRunRecords(historyDir);
    expect(records.filter(isRunning).map((r) => r.runId)).toEqual(["running"]);
    // Ending one that ended already keeps its first end.
    expect(records.find((r) => r.runId === "recent")?.endedAt).toBe("2026-11-20T00:00:00.000Z");

    await pruneRunRecords(historyDir, now);
    expect((await readdir(historyDir)).sort()).toEqual(["recent.json", "running.json"]);
  });
});

describe("following", () => {
  async function session(name: string) {
    const path = join(home, "projects", "-scratch", `${name}.jsonl`);
    await mkdir(join(home, "projects", "-scratch"), { recursive: true });
    await writeFile(path, `${line("user", "The Brief")}\n`);
    return path;
  }
  const collect = () => {
    const printed: string[] = [];
    const notes: string[] = [];
    return { printed, notes, print: (l: string) => printed.push(l), note: (l: string) => notes.push(l) };
  };
  const env = () => ({ CLAUDE_CONFIG_DIR: home });

  test("a Run that ended is printed whole, found by its session id, lines led by its key", async () => {
    const path = await session("s-1");
    await appendFile(path, `${line("assistant", [{ type: "text", text: "Done." }])}\n`);
    await writeRunRecord(historyDir, record({ sessionId: "s-1", endedAt: "2026-11-24T11:00:00.000Z" }));
    const out = collect();
    expect(await followRun("CRONK-12", { historyDir, env: env(), ...out, pollMs: 10 })).toBe(0);
    expect(out.printed).toEqual(["CRONK-12  Done."]);
    expect(out.notes[0]).toMatch(/^Showing CRONK-12 \(Run 11111111/);
  });

  test("--raw prints the JSONL lines as they are", async () => {
    const path = await session("s-1");
    await writeRunRecord(historyDir, record({ transcriptPath: path, endedAt: "2026-11-24T11:00:00.000Z" }));
    const out = collect();
    await followRun("CRONK-12", { historyDir, env: {}, ...out, raw: true, pollMs: 10 });
    expect(out.printed).toEqual([line("user", "The Brief")]);
  });

  test("a running Run is followed as its file grows, a half-written line waiting for its end, until the Run ends", async () => {
    const path = await session("s-2");
    await writeRunRecord(historyDir, record({ transcriptPath: path }));
    const out = collect();
    const following = followRun("CRONK-12", { historyDir, env: {}, ...out, pollMs: 10 });
    const text = line("assistant", [{ type: "tool_use", id: "t", name: "Grep", input: { pattern: "TODO" } }]);
    await appendFile(path, text.slice(0, 20));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(out.printed).toEqual([]);
    await appendFile(path, `${text.slice(20)}\n${line("assistant", [{ type: "text", text: "Found none." }])}\n`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await writeRunRecord(historyDir, record({ transcriptPath: path, endedAt: new Date().toISOString() }));
    expect(await following).toBe(0);
    expect(out.printed).toEqual(["CRONK-12  [Grep] TODO", "CRONK-12  Found none."]);
    expect(out.notes.at(-1)).toBe("CRONK-12: Run 11111111-1111-4111-8111-111111111111 ended.");
  });

  test("an unknown Run, or one whose session file is gone, says so", async () => {
    const out = collect();
    expect(await followRun("CRONK-99", { historyDir, env: {}, ...out })).toBe(1);
    expect(out.notes[0]).toMatch(/^No Run of CRONK-99 on this Machine/);
    await writeRunRecord(historyDir, record({ sessionId: "gone", endedAt: "2026-11-24T11:00:00.000Z" }));
    expect(await followRun("CRONK-12", { historyDir, env: env(), ...out, pollMs: 10 })).toBe(0);
    expect(out.notes.at(-1)).toMatch(/session file is gone/);
  });

  test("without a Run, follows those running now and those that start later, not those that ended", async () => {
    const first = await session("s-a");
    const second = await session("s-b");
    await writeRunRecord(historyDir, record({ runId: "ended", ticketKey: "CRONK-1", endedAt: "2026-11-24T11:00:00.000Z" }));
    await writeRunRecord(historyDir, record({ runId: "a", ticketKey: "CRONK-2", transcriptPath: first }));
    const out = collect();
    const abort = new AbortController();
    const following = followRunning({ historyDir, env: {}, ...out, pollMs: 10, signal: abort.signal });
    await appendFile(first, `${line("assistant", [{ type: "text", text: "From a." }])}\n`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await writeRunRecord(historyDir, record({ runId: "b", ticketKey: "CRONK-3", transcriptPath: second }));
    await appendFile(second, `${line("assistant", [{ type: "text", text: "From b." }])}\n`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await endRunRecord(historyDir, "a");
    await new Promise((resolve) => setTimeout(resolve, 50));
    abort.abort();
    expect(await following).toBe(0);
    expect(out.printed).toEqual(["CRONK-2  From a.", "CRONK-3  From b."]);
    expect(out.notes).toEqual([
      expect.stringMatching(/^Following CRONK-2 \(Run a,/),
      expect.stringMatching(/^Following CRONK-3 \(Run b,/),
      "CRONK-2: Run a ended.",
    ]);
  });

  test("with nothing running, says it waits", async () => {
    const out = collect();
    const abort = new AbortController();
    abort.abort();
    await followRunning({ historyDir, env: {}, ...out, signal: abort.signal });
    expect(out.notes).toEqual([]);
    const later = new AbortController();
    const following = followRunning({ historyDir, env: {}, ...out, pollMs: 10, signal: later.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    later.abort();
    await following;
    expect(out.notes).toEqual([expect.stringMatching(/^No Runs are running on this Machine now/)]);
  });
});

test("--daemon follows the service's log: launchd's file on macOS, journalctl on Linux, or says why there is none", () => {
  const all = () => true;
  const none = () => false;
  expect(daemonLogCommand("darwin", "/Users/ada", all)).toEqual({
    command: "tail",
    args: ["-n", "200", "-F", "/Users/ada/Library/Logs/cronk-runner.log"],
  });
  expect(daemonLogCommand("linux", "/home/ada", all)).toEqual({
    command: "journalctl",
    args: ["--user", "-u", "cronk-runner.service", "-n", "200", "-f"],
  });
  for (const platform of ["darwin", "linux", "win32"] as const)
    expect(daemonLogCommand(platform, "/home/ada", none)).toEqual({
      problem: expect.stringContaining("`cronk-runner run` prints its log in its own terminal"),
    });
});
