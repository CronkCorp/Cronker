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

/** What claiming a Run answers: what the daemon needs to run `claude` for it. */
export interface ClaimedRun {
  runId: string;
  ticketKey: string;
  brief: string;
  modelId: string;
  token: string;
  mcpUrl: string;
  /** The Runner's allowlist: Claude Code permission rules for the tools the Run may use without asking. */
  allowedTools: string[];
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
