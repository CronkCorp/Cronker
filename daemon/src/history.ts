import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * What the Machine remembers of each Run it started, so `cronk-runner logs` can find a Run by its Ticket's key and
 * follow its session: one `<runId>.json` in `history/` under the state directory, written when the Run starts,
 * updated as its session becomes known and when it ends, and kept a week after it ended. Apart from the process
 * records in the state directory itself, which only say what is running now and go when the Run ends.
 */
export interface RunRecord {
  runId: string;
  ticketKey: string;
  cronkUrl: string;
  /** The `claude` process's pid. */
  pid: number | null;
  /** Claude Code's session id, once its stream said it. */
  sessionId: string | null;
  /** The session's JSONL, once the daemon found it. */
  transcriptPath: string | null;
  startedAt: string;
  /** When the Run ended here; null while it runs, or if the daemon running it stopped unexpectedly. */
  endedAt: string | null;
}

/** How long an ended Run's record is kept: a week. */
export const keepEndedMs = 7 * 24 * 60 * 60 * 1000;

/** The history directory under the state directory. */
export const historyDirOf = (stateDir: string): string => join(stateDir, "history");

/** Writes the record whole, readable by its User alone, through a rename so a reader never sees half of it. */
export async function writeRunRecord(dir: string, record: RunRecord): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${record.runId}.json`);
  const temporary = join(dir, `.${record.runId}.${process.pid}.tmp`);
  await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
  await rename(temporary, path);
}

/** The record of the Run, or null when there is none or it can't be read. */
export async function readRunRecord(dir: string, runId: string): Promise<RunRecord | null> {
  try {
    return parse(await readFile(join(dir, `${runId}.json`), "utf8"));
  } catch {
    return null;
  }
}

/** Every readable record, newest start first. */
export async function readRunRecords(dir: string): Promise<RunRecord[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const records = await Promise.all(
    names
      .filter((name) => name.endsWith(".json") && !name.startsWith("."))
      .map((name) => readRunRecord(dir, name.slice(0, -".json".length))),
  );
  return records
    .filter((record): record is RunRecord => record !== null)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Marks the Run's record ended, if it has one that isn't yet. */
export async function endRunRecord(dir: string, runId: string, at = new Date()): Promise<void> {
  const record = await readRunRecord(dir, runId);
  if (record && !record.endedAt) await writeRunRecord(dir, { ...record, endedAt: at.toISOString() });
}

/** Whether the record's Run still runs: not ended, and its process alive. */
export function isRunning(record: RunRecord): boolean {
  if (record.endedAt) return false;
  if (record.pid === null) return true;
  try {
    process.kill(record.pid, 0);
    return true;
  } catch (error) {
    // Alive, but another user's: not ours, yet not gone either.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Removes the records of Runs that ended more than `keepMs` ago, those of Runs whose process went without an end
 * (a daemon stopped unexpectedly) counting from their start.
 */
export async function pruneRunRecords(dir: string, now = Date.now(), keepMs = keepEndedMs): Promise<void> {
  for (const record of await readRunRecords(dir)) {
    const since = record.endedAt ?? (isRunning(record) ? null : record.startedAt);
    if (since !== null && now - Date.parse(since) > keepMs)
      await rm(join(dir, `${record.runId}.json`), { force: true });
  }
}

function parse(text: string): RunRecord | null {
  const record = JSON.parse(text) as Partial<RunRecord>;
  if (typeof record.runId !== "string" || typeof record.ticketKey !== "string" || typeof record.startedAt !== "string")
    return null;
  return {
    runId: record.runId,
    ticketKey: record.ticketKey,
    cronkUrl: typeof record.cronkUrl === "string" ? record.cronkUrl : "",
    pid: typeof record.pid === "number" ? record.pid : null,
    sessionId: typeof record.sessionId === "string" ? record.sessionId : null,
    transcriptPath: typeof record.transcriptPath === "string" ? record.transcriptPath : null,
    startedAt: record.startedAt,
    endedAt: typeof record.endedAt === "string" ? record.endedAt : null,
  };
}
