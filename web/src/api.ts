/** A thin client for Cronk's HTTP API. The web client holds no rules of its own. */

export interface User {
  id: string;
  email: string;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  isAdmin: boolean;
}

export interface Workspace {
  id: string;
  name: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  if (response.status === 204) return undefined as T;
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = (json as { error?: { code?: string; message?: string } }).error;
    throw new ApiError(response.status, error?.code ?? "unknown", error?.message ?? response.statusText);
  }
  return json as T;
}

export const api = {
  setupNeeded: () => call<{ needed: boolean }>("GET", "/api/setup").then((r) => r.needed),
  setUp: (input: { setupCode: string; email: string; password: string; workspaceName: string }) =>
    call<{ user: User; workspace: Workspace }>("POST", "/api/setup", input),
  signIn: (email: string, password: string) => call<{ user: User }>("POST", "/api/sign-in", { email, password }),
  signOut: () => call<void>("DELETE", "/api/sign-in"),
  me: () => call<{ user: User; workspaces: WorkspaceSummary[] }>("GET", "/api/me"),
  workspace: (id: string) => call<Workspace>("GET", `/api/workspaces/${encodeURIComponent(id)}`),
};
