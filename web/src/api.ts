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

export type StatusKind = "backlog" | "active" | "review" | "done" | "canceled";

export const statusKinds: { kind: StatusKind; label: string }[] = [
  { kind: "backlog", label: "Backlog" },
  { kind: "active", label: "Active" },
  { kind: "review", label: "Review" },
  { kind: "done", label: "Done" },
  { kind: "canceled", label: "Canceled" },
];

export interface Status {
  id: string;
  name: string;
  kind: StatusKind;
}

export interface ProjectSummary {
  id: string;
  workspaceId: string;
  name: string;
  key: string;
}

export interface Project extends ProjectSummary {
  statuses: Status[];
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
  projects: (workspaceId: string) =>
    call<ProjectSummary[]>("GET", `/api/workspaces/${encodeURIComponent(workspaceId)}/projects`),
  createProject: (workspaceId: string, input: { name: string; key: string }) =>
    call<Project>("POST", `/api/workspaces/${encodeURIComponent(workspaceId)}/projects`, input),
  project: (id: string) => call<Project>("GET", `/api/projects/${encodeURIComponent(id)}`),
  addStatus: (projectId: string, input: { name: string; kind: StatusKind; position?: number }) =>
    call<Project>("POST", `/api/projects/${encodeURIComponent(projectId)}/statuses`, input),
  editStatus: (projectId: string, statusId: string, input: { name?: string; kind?: StatusKind; position?: number }) =>
    call<Project>(
      "PATCH",
      `/api/projects/${encodeURIComponent(projectId)}/statuses/${encodeURIComponent(statusId)}`,
      input,
    ),
  removeStatus: (projectId: string, statusId: string) =>
    call<Project>("DELETE", `/api/projects/${encodeURIComponent(projectId)}/statuses/${encodeURIComponent(statusId)}`),
};
