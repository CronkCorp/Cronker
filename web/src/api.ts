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

export type PendingAdd =
  | { user: User; addedVia: "email"; addedAt: string; /** When the last of their links to join expires. */ expiresAt: string }
  | { user: User; addedVia: "github"; addedAt: string };

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

/** One of the named ways a Step's Run may end, moving the Ticket to a Status. */
export interface Outcome {
  name: string;
  statusId: string;
  default: boolean;
  needsYou: boolean;
  countsAsRound: boolean;
}

/** The agent work a Status asks for. */
export interface Step {
  brief: string;
  model: string;
  roundLimit: number;
  outcomes: Outcome[];
}

export interface Status {
  id: string;
  name: string;
  kind: StatusKind;
  step: Step | null;
}

/** The Brief a Run would start from, in its three parts and joined. */
export interface Brief {
  preamble: string;
  brief: string;
  ticketKey: string;
  text: string;
}

export interface ProjectSummary {
  id: string;
  workspaceId: string;
  name: string;
  key: string;
}

export interface Project extends ProjectSummary {
  newTicketsDelegated: boolean;
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
  delegateId: string | null;
  parentId: string | null;
  dueDate: string | null;
  estimate: number | null;
  createdBy: string;
  createdAt: string;
  lastRun: { id: string; state: RunState } | null;
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
  delegateId?: string | null;
  dueDate?: string | null;
  estimate?: number | null;
  parentId?: string | null;
}

/** A Ticket as another Ticket's Relations, parent, Sub-Tickets and Changes name it. */
export interface TicketRef {
  id: string;
  projectId: string;
  key: string;
  title: string;
}

/** A Relation as seen from one of its Tickets. */
export type RelationKind = "blocks" | "blockedBy" | "relatesTo";

export interface Relation {
  id: string;
  kind: RelationKind;
  ticket: TicketRef;
}

export interface TicketRelations {
  parent: TicketRef | null;
  subTickets: TicketRef[];
  relations: Relation[];
}

export interface TicketFilter {
  statusId?: string;
  assigneeId?: string;
  priority?: Priority;
  label?: string;
}

export interface Agent {
  id: string;
  workspaceId: string;
  name: string;
  owner: User;
  runnerId: string | null;
  createdAt: string;
}

export type TokenAccess = "full" | "read";

export interface AgentToken {
  id: string;
  name: string;
  access: TokenAccess;
  createdAt: string;
}

export interface Actor {
  kind: "user" | "agent";
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
  field:
    | "created"
    | "title"
    | "description"
    | "status"
    | "priority"
    | "labels"
    | "assignee"
    | "dueDate"
    | "estimate"
    | "parent"
    | "subTicket"
    | "delegate"
    | RelationKind;
  from: unknown;
  to: unknown;
}

export type RunState = "running" | "finished" | "failed" | "lost" | "stopped" | "refused";

/** One agent execution Cronk started for a Ticket. */
export interface Run {
  id: string;
  ticketId: string;
  step: { statusId: string | null; name: string };
  agent: { id: string; name: string };
  model: string;
  state: RunState;
  outcome: string | null;
  question: string | null;
  report: string | null;
  endReason: string | null;
  sessionUrl: string | null;
  startedAt: string;
  endedAt: string | null;
}

/** A Ticket in a Review Status, waiting for its Assignee's review. */
export interface ReviewItem {
  kind: "review";
  ticket: TicketSummary;
  status: { id: string; name: string };
}

/** A Ticket whose latest Run failed, was lost or couldn't start, waiting for Retry. */
export interface RunItem {
  kind: "run";
  ticket: TicketSummary;
  run: { id: string; state: "failed" | "lost" | "refused"; step: { statusId: string; name: string }; endReason: string | null };
}

export type InboxItem = ReviewItem | RunItem;

/** A Workspace's settings beyond its name, set by its Admins. */
export interface WorkspaceSettings {
  lostRunMinutes: number;
}

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

/** An app's request to act in Cronk as one of the signed-in User's Agents, for the consent screen. */
export interface ConnectRequest {
  client: { id: string; name: string | null };
  redirectUri: string;
  agents: { id: string; name: string; workspace: Workspace }[];
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
  workspaceSettings: (id: string) => call<WorkspaceSettings>("GET", `${ws(id)}/settings`),
  changeWorkspaceSettings: (id: string, change: Partial<WorkspaceSettings>) =>
    call<WorkspaceSettings>("PATCH", `${ws(id)}/settings`, change),
  members: (id: string) => call<Member[]>("GET", `${ws(id)}/members`),
  addMember: (id: string, email: string) =>
    call<{ user: User; link: Link }>("POST", `${ws(id)}/members`, { email }),
  setAdmin: (id: string, userId: string, isAdmin: boolean) =>
    call<Member>("PATCH", `${ws(id)}/members/${encodeURIComponent(userId)}`, { isAdmin }),
  removeMember: (id: string, userId: string) => call<void>("DELETE", `${ws(id)}/members/${encodeURIComponent(userId)}`),
  pendingAdds: (id: string) => call<PendingAdd[]>("GET", `${ws(id)}/pending-adds`),
  cancelPendingAdd: (id: string, userId: string) =>
    call<void>("DELETE", `${ws(id)}/pending-adds/${encodeURIComponent(userId)}`),
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
  editProject: (id: string, edit: { newTicketsDelegated?: boolean }) =>
    call<Project>("PATCH", `/api/projects/${encodeURIComponent(id)}`, edit),
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
  putStep: (projectId: string, statusId: string, step: Step) =>
    call<Project>(
      "PUT",
      `/api/projects/${encodeURIComponent(projectId)}/statuses/${encodeURIComponent(statusId)}/step`,
      step,
    ),
  removeStep: (projectId: string, statusId: string) =>
    call<Project>(
      "DELETE",
      `/api/projects/${encodeURIComponent(projectId)}/statuses/${encodeURIComponent(statusId)}/step`,
    ),
  ticketByKey: (workspaceId: string, key: string) =>
    call<Ticket>("GET", `/api/workspaces/${encodeURIComponent(workspaceId)}/tickets/${encodeURIComponent(key)}`),
  brief: (ticketId: string) => call<Brief>("GET", `/api/tickets/${encodeURIComponent(ticketId)}/brief`),
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
  agents: (workspaceId: string) => call<Agent[]>("GET", `${ws(workspaceId)}/agents`),
  createAgent: (workspaceId: string, name: string) => call<Agent>("POST", `${ws(workspaceId)}/agents`, { name }),
  renameAgent: (id: string, name: string) => call<Agent>("PATCH", agent(id), { name }),
  removeAgent: (id: string) => call<void>("DELETE", agent(id)),
  tokens: (agentId: string) => call<AgentToken[]>("GET", `${agent(agentId)}/tokens`),
  issueToken: (agentId: string, input: { name: string; access: TokenAccess }) =>
    call<{ token: AgentToken; secret: string }>("POST", `${agent(agentId)}/tokens`, input),
  revokeToken: (agentId: string, tokenId: string) =>
    call<void>("DELETE", `${agent(agentId)}/tokens/${encodeURIComponent(tokenId)}`),
  relations: (ticketId: string) =>
    call<TicketRelations>("GET", `/api/tickets/${encodeURIComponent(ticketId)}/relations`),
  relate: (ticketId: string, input: { kind: RelationKind } & ({ ticketId: string } | { ticketKey: string })) =>
    call<Relation>("POST", `/api/tickets/${encodeURIComponent(ticketId)}/relations`, input),
  removeRelation: (ticketId: string, relationId: string) =>
    call<void>("DELETE", `/api/tickets/${encodeURIComponent(ticketId)}/relations/${encodeURIComponent(relationId)}`),
  runs: (ticketId: string) => call<Run[]>("GET", `/api/tickets/${encodeURIComponent(ticketId)}/runs`),
  retry: (ticketId: string) => call<Run>("POST", `/api/tickets/${encodeURIComponent(ticketId)}/retry`),
  connectRequest: (requestId: string) => call<ConnectRequest>("GET", connect(requestId)),
  approveConnect: (requestId: string, agentId: string) =>
    call<{ redirectTo: string }>("POST", `${connect(requestId)}/approve`, { agentId }),
  denyConnect: (requestId: string) => call<{ redirectTo: string }>("POST", `${connect(requestId)}/deny`),
  timeline: (ticketId: string) => call<Change[]>("GET", `/api/tickets/${encodeURIComponent(ticketId)}/timeline`),
};

function ws(id: string) {
  return `/api/workspaces/${encodeURIComponent(id)}`;
}

function connect(requestId: string) {
  return `/api/oauth/requests/${encodeURIComponent(requestId)}`;
}

function agent(id: string) {
  return `/api/agents/${encodeURIComponent(id)}`;
}
