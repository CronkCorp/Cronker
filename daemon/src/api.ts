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

/** What claiming a Run answers: what the daemon needs to run `claude` for it. */
export interface ClaimedRun {
  runId: string;
  ticketKey: string;
  brief: string;
  modelId: string;
  token: string;
  mcpUrl: string;
  repositories: ClaimedRepository[];
  /** The Runner's allowlist: Claude Code permission rules for the tools the Run may use without asking. */
  allowedTools: string[];
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

/** Uploads a file's text to Cronk as `contentType`, such as a transcript's JSONL, with the token given. */
export async function upload(cronkUrl: string, method: string, path: string, options: { body: string; contentType: string; token: string }): Promise<void> {
  const response = await fetch(`${cronkUrl}${path}`, {
    method,
    headers: { accept: "application/json", "content-type": options.contentType, authorization: `Bearer ${options.token}` },
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

export async function call<T>(cronkUrl: string, method: string, path: string, options: { body?: unknown; token?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.token) headers.authorization = `Bearer ${options.token}`;
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
