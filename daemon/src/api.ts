import { daemonVersion } from "./version.js";

/** The few calls the daemon makes to Cronk's HTTP API, and what they answer. */

export interface StartedPairing {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
  interval: number;
}

export interface PairedMachine {
  machineToken: string;
  machine: { id: string; name: string };
}

export interface MachineSelf {
  id: string;
  name: string;
  owner: { id: string; email: string | null };
  runners: { id: string; name: string }[];
}

/** A fresh GitHub App installation token for one of a Run's Repositories. */
export interface RepositoryToken {
  /** `owner/name`. */
  fullName: string;
  token: string;
  expiresAt: string;
}

/** One of a Run's Repositories, with where it is cloned from and the branch to start on, if the remote has it. */
export interface ClaimedRepository extends RepositoryToken {
  cloneUrl: string;
  startBranch: string | null;
}

/**
 * What claiming a Run answers: what the daemon needs to run it. A Run on Claude has `modelId`, for `claude --model`;
 * a Run on a Machine model has `machineModel`, its name on this Machine, instead.
 */
export interface ClaimedRun {
  runId: string;
  ticketKey: string;
  brief: string;
  modelId?: string;
  machineModel?: string;
  token: string;
  mcpUrl: string;
  repositories: ClaimedRepository[];
  /** The Runner's allowlist: Claude Code permission rules for the tools the Run may use without asking. */
  allowedTools: string[];
  /**
   * The Runner's allowed directories: absolute paths outside the worktrees the Run may read and write. Left out by a
   * Cronk too old to know them, which opens none.
   */
  allowedDirectories?: string[];
  /** Whether the Run's Step is read-only, so its file edits are refused whatever the allowlist says. */
  readOnly?: boolean;
}

/** What a heartbeat answers: fresh tokens for the Run's Repositories once theirs near their expiry. */
export interface HeartbeatAnswer {
  repositories: RepositoryToken[];
}

/** What reporting a Run's end answers: whether it is lost and may yet come back, so its worktree is kept. */
export interface RunEnded {
  mayComeBack: boolean;
}

/** A refusal from Cronk, with its error code. */
export class CronkError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The headers of every call with a Machine token: its token, and the daemon's version and the Machine's limit, which
 * Cronk records each time, so a changed limit takes effect without pairing again, and refuses a daemon too old for it.
 */
export function machineHeaders(token: string, limit: number): Record<string, string> {
  return { authorization: `Bearer ${token}`, "x-cronk-runner-version": daemonVersion, "x-cronk-runner-limit": String(limit) };
}

/** Uploads a file's text to Cronk as `contentType`, such as a transcript's JSONL, with the headers given. */
export async function upload(
  cronkUrl: string,
  method: string,
  path: string,
  options: { body: string; contentType: string; headers: Record<string, string> },
): Promise<void> {
  const response = await fetch(`${cronkUrl}${path}`, {
    method,
    headers: { accept: "application/json", ...options.headers, "content-type": options.contentType },
    body: options.body,
    signal: AbortSignal.timeout(120_000),
  });
  if (response.ok) {
    await response.body?.cancel();
    return;
  }
  const json = (await response.json().catch(() => ({}))) as { error?: { code: string; message: string } };
  throw new CronkError(response.status, json.error?.code ?? "unknown", json.error?.message ?? `Cronk answered ${response.status}.`);
}

export async function call<T>(
  cronkUrl: string,
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json", ...options.headers };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${cronkUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await response.json().catch(() => ({}))) as { error?: { code: string; message: string } };
  if (!response.ok) {
    throw new CronkError(response.status, json.error?.code ?? "unknown", json.error?.message ?? `Cronk answered ${response.status}.`);
  }
  return json as T;
}
