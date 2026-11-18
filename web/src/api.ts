/** A thin client for Cronk's HTTP API. The web client holds no rules of its own. */

export interface User {
  id: string;
  /** Unknown for a User added by GitHub login until they first sign in. */
  email: string | null;
  githubLogin: string | null;
}

/** How to show a User: their email, else their GitHub login. */
export function nameOf(user: User): string {
  return user.email ?? `@${user.githubLogin}`;
}

export interface GitHubApp {
  name: string;
  githubAccount: string;
  htmlUrl: string;
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

export interface Member {
  user: User;
  isAdmin: boolean;
}

export interface Link {
  url: string;
  expiresAt: string;
}

export interface LinkDetails {
  kind: "join" | "reset";
  email: string | null;
  workspace: Workspace | null;
  setsPassword: boolean;
  signInWithGitHub: boolean;
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

export type Priority = "urgent" | "high" | "medium" | "low" | "none";

export const priorities: { priority: Priority; label: string }[] = [
  { priority: "urgent", label: "Urgent" },
  { priority: "high", label: "High" },
  { priority: "medium", label: "Medium" },
  { priority: "low", label: "Low" },
  { priority: "none", label: "None" },
];

/** A Ticket key written in Markdown that names a Ticket of the Workspace. */
export interface Mention {
  text: string;
  key: string;
  ticketId: string;
}

export interface TicketSummary {
  id: string;
  projectId: string;
  key: string;
  title: string;
  description: string;
  statusId: string;
  priority: Priority;
  labels: string[];
  assigneeId: string | null;
  dueDate: string | null;
  estimate: number | null;
  createdBy: string;
  createdAt: string;
}

export interface Ticket extends TicketSummary {
  mentions: Mention[];
}

export interface TicketEdit {
  title?: string;
  description?: string;
  statusId?: string;
  priority?: Priority;
  labels?: string[];
  assigneeId?: string | null;
  dueDate?: string | null;
  estimate?: number | null;
}

export interface TicketFilter {
  statusId?: string;
  assigneeId?: string;
  priority?: Priority;
  label?: string;
}

export interface Actor {
  kind: "user";
  id: string;
  name: string;
}

export interface Comment {
  id: string;
  ticketId: string;
  replyToId: string | null;
  body: string;
  actor: Actor;
  createdAt: string;
  mentions: Mention[];
}

export interface Change {
  id: string;
  actor: Actor;
  at: string;
  field: "created" | "title" | "description" | "status" | "priority" | "labels" | "assignee" | "dueDate" | "estimate";
  from: unknown;
  to: unknown;
}

/** A Ticket in a Review Status, waiting for its Assignee's review. */
export interface ReviewItem {
  kind: "review";
  ticket: TicketSummary;
  status: { id: string; name: string };
}

export type InboxItem = ReviewItem;

export interface Inbox {
  count: number;
  items: InboxItem[];
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
  changePassword: (currentPassword: string, newPassword: string) =>
    call<void>("PUT", "/api/me/password", { currentPassword, newPassword }),
  workspace: (id: string) => call<Workspace>("GET", ws(id)),
  createWorkspace: (name: string) => call<WorkspaceSummary>("POST", "/api/workspaces", { name }),
  renameWorkspace: (id: string, name: string) => call<Workspace>("PATCH", ws(id), { name }),
  members: (id: string) => call<Member[]>("GET", `${ws(id)}/members`),
  addMember: (id: string, email: string) =>
    call<{ user: User; link: Link }>("POST", `${ws(id)}/members`, { email }),
  setAdmin: (id: string, userId: string, isAdmin: boolean) =>
    call<Member>("PATCH", `${ws(id)}/members/${encodeURIComponent(userId)}`, { isAdmin }),
  removeMember: (id: string, userId: string) => call<void>("DELETE", `${ws(id)}/members/${encodeURIComponent(userId)}`),
  resetLink: (id: string, userId: string) => call<Link>("POST", `${ws(id)}/members/${encodeURIComponent(userId)}/reset-link`),
  addMemberByGitHub: (id: string, login: string) =>
    call<{ user: User }>("POST", `${ws(id)}/members/github`, { login }),
  githubApp: () => call<{ app: GitHubApp | null }>("GET", "/api/github/app").then((r) => r.app),
  startGitHubApp: (githubOrganization?: string) =>
    call<{ url: string; manifest: Record<string, unknown> }>("POST", "/api/github/app/manifest", { githubOrganization }),
  lookUpLink: (token: string) => call<LinkDetails>("POST", "/api/links/lookup", { token }),
  useLink: (token: string, password: string) => call<{ user: User }>("POST", "/api/links/use", { token, password }),
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
  tickets: (projectId: string, filter: TicketFilter = {}) => {
    const query = new URLSearchParams(Object.entries(filter).filter(([, value]) => value));
    const search = query.size ? `?${query}` : "";
    return call<TicketSummary[]>("GET", `/api/projects/${encodeURIComponent(projectId)}/tickets${search}`);
  },
  createTicket: (projectId: string, input: { title: string; description?: string }) =>
    call<Ticket>("POST", `/api/projects/${encodeURIComponent(projectId)}/tickets`, input),
  ticket: (id: string) => call<Ticket>("GET", `/api/tickets/${encodeURIComponent(id)}`),
  editTicket: (id: string, edit: TicketEdit) => call<Ticket>("PATCH", `/api/tickets/${encodeURIComponent(id)}`, edit),
  comments: (ticketId: string) => call<Comment[]>("GET", `/api/tickets/${encodeURIComponent(ticketId)}/comments`),
  comment: (ticketId: string, input: { body: string; replyToId?: string }) =>
    call<Comment>("POST", `/api/tickets/${encodeURIComponent(ticketId)}/comments`, input),
  inbox: (workspaceId: string) => call<Inbox>("GET", `${ws(workspaceId)}/inbox`),
  /** The Workspace's live event stream; see `useInboxSignal`. */
  eventsUrl: (workspaceId: string) => `${ws(workspaceId)}/events`,
  timeline: (ticketId: string) => call<Change[]>("GET", `/api/tickets/${encodeURIComponent(ticketId)}/timeline`),
};

function ws(id: string) {
  return `/api/workspaces/${encodeURIComponent(id)}`;
}
