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

/** What the GitHub App lacks of what Cronk needs, as GitHub reports it. */
export interface GitHubChecklist {
  settingsUrl: string;
  missingPermissions: Record<string, string>;
  missingEvents: string[];
  webhook: { url: string; secret: string } | null;
  installationsNotAccepted: { account: string; htmlUrl: string; missingPermissions: Record<string, string> }[];
}

export interface GitHubInstallation {
  account: string;
  repositories: { id: number; fullName: string }[];
}

/** A GitHub repository a Project lists as holding its code. */
export interface Repository {
  /** GitHub's id, which stays the same through renames and transfers. */
  id: number;
  fullName: string;
  /** Whether a Project of another Workspace lists it under the same key, so its Pull Requests link there too. */
  keyClash: boolean;
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

/** Which Tickets a Step lets through: only those with the Label, or only those without it. */
export interface LabelRule {
  kind: "requires" | "skippedBy";
  label: string;
}

/** How a Label rule reads, such as `skipped by no-review`. */
export const labelRuleShown = ({ kind, label }: LabelRule) =>
  kind === "requires" ? `requires ${label}` : `skipped by ${label}`;

/** The agent work a Status asks for. */
export interface Step {
  brief: string;
  model: string;
  roundLimit: number;
  labelRule: LabelRule | null;
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
  /** Whether a Ticket takes Autonomous Delegation when first delegated. */
  autonomousDelegationDefault: boolean;
  /** Whether a merged Pull Request completes the Tickets it links. */
  pullRequestAutomation: boolean;
  statuses: Status[];
}

/** The settings a User changes on a Project. */
export interface ProjectEdit {
  newTicketsDelegated?: boolean;
  autonomousDelegationDefault?: boolean;
  pullRequestAutomation?: boolean;
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
  /** Null until a User sets it or the Ticket is first delegated. */
  autonomousDelegation: boolean | null;
  /** For a Ticket a Run completed: Unverified until a User Accepts (Verified) or Reopens it. */
  verification: "unverified" | "verified" | null;
  parentId: string | null;
  /** For a Discovered Ticket: the Agent that filed it, from which Ticket and Run, and whether it waits for a User. */
  discovered: { agentId: string; sourceTicket: TicketRef | null; runId: string | null; waiting: boolean } | null;
  dueDate: string | null;
  estimate: number | null;
  createdBy: string;
  createdAt: string;
  lastRun: { id: string; state: RunState } | null;
  /** What it waits for before it gets the Run it needs, if it needs one. */
  waiting: "runnerSlot" | "runnerPaused" | "blocked" | null;
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
  autonomousDelegation?: boolean;
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

/** A subscription Runner's trigger: the claude.ai scheduled task it fires for one model label. Its token is never returned. */
export interface Trigger {
  id: string;
  model: string;
  /** The Project it overrides the Runner's own trigger on; null for all Projects. */
  projectId: string | null;
  triggerId: string;
  createdAt: string;
}

/** A way for Cronk to start Runs of the User's Agents with their own credentials. */
export interface Runner {
  id: string;
  name: string;
  kind: string;
  limit: number;
  /** How many of its Runs are running now, counted against its limit. */
  running: number;
  /** Until when a rate limit pauses its queue. */
  pausedUntil: string | null;
  triggers: Trigger[];
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
  /** Who wrote it: a User, an Agent, or Cronk itself, as when a failing check sent the Ticket back. */
  actor: ChangeActor;
  createdAt: string;
  mentions: Mention[];
  /** The Question this Comment asks, if a Run asked one with it; the first User's reply answers it. */
  questionId: string | null;
  attachments: Attachment[];
}

/** What an Attachment is attached to. */
export interface AttachmentOwner {
  kind: "ticket" | "document" | "comment";
  id: string;
}

/** A plain file attached to a Ticket, Document or Comment. Markdown refers to it as `attachment:<id>`. */
export interface Attachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  on: AttachmentOwner;
  actor: Actor;
  createdAt: string;
}

/** Where an Attachment downloads from, which Markdown's `attachment:<id>` resolves to. */
export function attachmentUrl(id: string): string {
  return `/api/attachments/${encodeURIComponent(id)}/content`;
}

/** Where a Project's or the Workspace's Terms and Decisions download from, as a zip of `GLOSSARY.md` and `docs/adr/`. */
export function exportUrl(place: Place): string {
  return `${placePath(place)}/export.zip`;
}

/** Whether a URL is where an Attachment downloads from. */
export function isAttachmentUrl(url: string): boolean {
  return /^\/api\/attachments\/[^/]+\/content$/.test(url);
}

/** Markdown a Run wrote on its Ticket. */
export interface Report {
  id: string;
  ticketId: string;
  runId: string;
  agent: { id: string; name: string };
  title: string;
  body: string;
  createdAt: string;
}

/** Who made a Change: a User, an Agent, or Cronk itself. */
export type ChangeActor = Actor | { kind: "cronk"; name: "Cronk" };

export interface Change {
  id: string;
  actor: ChangeActor;
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
    | "stepSkipped"
    | "autonomousDelegation"
    | "verification"
    | "dismissed"
    | "linkedDocument"
    | "merged"
    | RelationKind;
  from: unknown;
  to: unknown;
  /** The Run an Agent made the Change in; null for a User's, or an Agent's outside a Run. */
  runId: string | null;
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
  questionBy: "agent" | "cronk" | null;
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
  /** When it began waiting: when the Ticket entered its Review Status. */
  since: string;
}

/** A Ticket a Run completed, Unverified until its Assignee Accepts or Reopens it. */
export interface UnverifiedItem {
  kind: "unverified";
  ticket: TicketSummary;
  status: { id: string; name: string };
  /** The Step that completed it, by its Status; null once that Status is removed. */
  completedBy: { id: string; name: string } | null;
  /** Whether no Step produced the work, as with a merge of a Pull Request a User opened. */
  completedWithoutStep: boolean;
  /** When it began waiting: when the Ticket was completed, by a Run or a merge, moving it to its Done Status. */
  since: string;
}

/** A Question a Run asked on a Ticket assigned to the User, until a User answers or dismisses it. */
export interface QuestionItem {
  kind: "question";
  ticket: TicketSummary;
  question: {
    id: string;
    commentId: string;
    body: string;
    agent: { id: string; name: string };
    step: { statusId: string | null; name: string };
    askedAt: string;
  };
  /** When it began waiting: when the Run asked the Question. */
  since: string;
}

/** A Ticket a Run's *needs you* Outcome moved, handing it back to its Assignee, until it moves again. */
export interface NeedsYouItem {
  kind: "needsYou";
  ticket: TicketSummary;
  status: { id: string; name: string };
  outcome: string;
  step: { statusId: string | null; name: string };
  /** Cronk's own Question, when it applied needs you past the Step's round limit. */
  question?: string;
  /** When it began waiting: when the needs you Outcome moved the Ticket. */
  since: string;
}

/** A Ticket whose latest Run failed, was lost or couldn't start, waiting for Retry. */
export interface RunItem {
  kind: "run";
  ticket: TicketSummary;
  run: { id: string; state: "failed" | "lost" | "refused"; step: { statusId: string; name: string }; endReason: string | null };
  /** When it began waiting: when the Run ended, or was refused. */
  since: string;
}

/** A Discovered Ticket an Agent filed, waiting for its Assignee to delegate, move or dismiss it. */
export interface DiscoveredItem {
  kind: "discovered";
  ticket: TicketSummary;
  agent: { id: string; name: string };
  /** When it began waiting: when the Agent filed the Ticket. */
  since: string;
}

/** A Ticket whose Assignee was removed from the Workspace, waiting for an Admin to assign it. */
export interface ReassignItem {
  kind: "reassign";
  ticket: TicketSummary;
  formerAssignee: User;
  /** When it began waiting: when the Assignee of the Ticket was removed from the Workspace. */
  since: string;
}

export type InboxItem = QuestionItem | NeedsYouItem | ReviewItem | UnverifiedItem | RunItem | DiscoveredItem | ReassignItem;

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
    /** Everything the refusal carried, such as the current Version a save was refused with. */
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** One saved state of a Document, recording the Actor who saved it. */
export interface Version {
  number: number;
  title: string;
  actor: Actor;
  savedAt: string;
}

export interface VersionWithBody extends Version {
  body: string;
}

/** A Document as its page tree lists it, without its body. */
export interface DocumentSummary {
  id: string;
  workspaceId: string;
  /** Null in the Workspace's page tree. */
  projectId: string | null;
  /** The Ticket it is a Report on, listed with the Ticket instead of in a page tree; null in a page tree. */
  ticketId: string | null;
  /** The Run that wrote it, for a Report. */
  runId: string | null;
  /** Null for a Report. */
  parentId: string | null;
  /** Null for a Report. */
  position: number | null;
  title: string;
  version: Version;
}

export interface Document extends DocumentSummary {
  body: string;
}

export interface DocumentEdit {
  baseVersion?: number;
  title?: string;
  body?: string;
  parentId?: string | null;
  position?: number;
}

/** A Document linked to a Ticket, from its Project's page tree or the Workspace's. */
export interface LinkedDocument {
  id: string;
  /** Null for a Document of the Workspace's page tree. */
  projectId: string | null;
  title: string;
}

/** A check on a Pull Request's latest commit: a check run, or a commit status by its context. */
export interface Check {
  name: string;
  state: "pending" | "passed" | "failed" | "neutral";
  url: string | null;
}

/** A Pull Request linked to a Ticket by its key in the Pull Request's branch or title. */
export interface PullRequest {
  id: number;
  repository: string;
  number: number;
  title: string;
  branch: string;
  url: string;
  state: "open" | "draft" | "merged" | "closed";
  checks: Check[];
  /** The login of the GitHub account that merged it, if GitHub named one. */
  mergedBy: string | null;
  /** The Step of the Run running on the Ticket when GitHub reported it opened. */
  producingStep: { runId: string; statusId: string | null; name: string } | null;
  /** What last sent the Ticket back to its producing Step from this Pull Request, if anything did. */
  sentBack:
    | { kind: "check"; name: string; sha: string; url: string | null; at: string }
    | { kind: "review"; reviewer: string | null; url: string | null; at: string }
    | null;
}

/** What completed a Ticket, and where Reopen sends it. */
export interface Completion {
  /** The merged Pull Request that completed it; null when a Run's Step did. */
  merge: {
    pullRequest: { id: number; repository: string; number: number; title: string; url: string };
    mergedBy: string | null;
  } | null;
  reopen: { kind: "back"; status: { id: string; name: string } } | { kind: "stays" } | { kind: "refused" };
}

/** Which page tree: a Project's, or the Workspace's. */
export type Tree = { kind: "project"; id: string } | { kind: "workspace"; id: string };

export interface Comparison<V extends VersionWithBody = VersionWithBody> {
  from: V;
  to: V;
  lines: { change: "same" | "removed" | "added"; text: string }[];
}

/** A Term naming one concept, with its definition and the words to avoid, kept by a Project or by the Workspace. */
export interface Term {
  id: string;
  workspaceId: string;
  /** Null for the Workspace's. */
  projectId: string | null;
  name: string;
  definition: string;
  avoid: string[];
  version: { number: number; actor: Actor; savedAt: string };
}

/** One saved state of a Term, recording the Actor who saved it. */
export interface TermVersion {
  number: number;
  name: string;
  definition: string;
  avoid: string[];
  actor: Actor;
  savedAt: string;
}

/** Two of a Term's Versions: their definitions compared line by line, and their words to avoid one by one. */
export interface TermComparison {
  from: TermVersion;
  to: TermVersion;
  lines: { change: "same" | "removed" | "added"; text: string }[];
  avoid: { change: "same" | "removed" | "added"; text: string }[];
}

export interface TermContent {
  name: string;
  definition: string;
  avoid: string[];
}

/** Where knowledge is kept: a Project, or the Workspace. */
export type Place = Tree;

export const decisionStatuses = ["proposed", "accepted", "rejected", "deprecated", "superseded"] as const;
export type DecisionStatus = (typeof decisionStatuses)[number];

/** One saved state of a Decision: its text and status, recording the Actor who saved it. */
export interface DecisionVersion extends Version {
  status: DecisionStatus;
  supersededById: string | null;
}

/** A Decision as its list shows it, without its body. */
export interface DecisionSummary {
  id: string;
  workspaceId: string;
  /** Null for the Workspace's own. */
  projectId: string | null;
  number: number;
  title: string;
  status: DecisionStatus;
  /** The Decision replacing it, while superseded. */
  supersededById: string | null;
  version: DecisionVersion;
}

export interface Decision extends DecisionSummary {
  body: string;
}

export interface DecisionEdit {
  baseVersion: number;
  title?: string;
  body?: string;
  status?: DecisionStatus;
  supersededById?: string | null;
}

/** An app's request to act in Cronk as one of the signed-in User's Agents, for the consent screen. */
export interface ConnectRequest {
  client: { id: string; name: string | null };
  redirectUri: string;
  agents: { id: string; name: string; workspace: Workspace }[];
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  // A file is sent as itself, with its media type; anything else as JSON.
  const file = body instanceof File ? body : undefined;
  const response = await fetch(path, {
    method,
    headers: file
      ? { "content-type": file.type || "application/octet-stream" }
      : body === undefined
        ? {}
        : { "content-type": "application/json" },
    body: file ?? (body === undefined ? undefined : JSON.stringify(body)),
    credentials: "same-origin",
  });
  if (response.status === 204) return undefined as T;
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = (json as { error?: { code?: string; message?: string } }).error;
    throw new ApiError(response.status, error?.code ?? "unknown", error?.message ?? response.statusText, error);
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
  githubChecklist: () => call<GitHubChecklist>("GET", "/api/github/app/checklist"),
  githubInstallations: () => call<GitHubInstallation[]>("GET", "/api/github/installations"),
  startGitHubApp: (githubOrganization?: string) =>
    call<{ url: string; manifest: Record<string, unknown> }>("POST", "/api/github/app/manifest", { githubOrganization }),
  lookUpLink: (token: string) => call<LinkDetails>("POST", "/api/links/lookup", { token }),
  useLink: (token: string, password: string) => call<{ user: User }>("POST", "/api/links/use", { token, password }),
  projects: (workspaceId: string) =>
    call<ProjectSummary[]>("GET", `/api/workspaces/${encodeURIComponent(workspaceId)}/projects`),
  createProject: (workspaceId: string, input: { name: string; key: string }) =>
    call<Project>("POST", `/api/workspaces/${encodeURIComponent(workspaceId)}/projects`, input),
  project: (id: string) => call<Project>("GET", `/api/projects/${encodeURIComponent(id)}`),
  editProject: (id: string, edit: ProjectEdit) =>
    call<Project>("PATCH", `/api/projects/${encodeURIComponent(id)}`, edit),
  repositories: (projectId: string) => call<Repository[]>("GET", `/api/projects/${encodeURIComponent(projectId)}/repositories`),
  addRepository: (projectId: string, id: number) =>
    call<Repository>("POST", `/api/projects/${encodeURIComponent(projectId)}/repositories`, { id }),
  removeRepository: (projectId: string, id: number) =>
    call<void>("DELETE", `/api/projects/${encodeURIComponent(projectId)}/repositories/${id}`),
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
  acceptTicket: (id: string) => call<Ticket>("POST", `/api/tickets/${encodeURIComponent(id)}/accept`),
  reopenTicket: (id: string, comment: string) =>
    call<Ticket>("POST", `/api/tickets/${encodeURIComponent(id)}/reopen`, { comment }),
  comments: (ticketId: string) => call<Comment[]>("GET", `/api/tickets/${encodeURIComponent(ticketId)}/comments`),
  comment: (ticketId: string, input: { body: string; replyToId?: string }) =>
    call<Comment>("POST", `/api/tickets/${encodeURIComponent(ticketId)}/comments`, input),
  reports: (ticketId: string) => call<Report[]>("GET", `/api/tickets/${encodeURIComponent(ticketId)}/reports`),
  inbox: (workspaceId: string) => call<Inbox>("GET", `${ws(workspaceId)}/inbox`),
  dismissQuestion: (questionId: string) => call<void>("POST", `/api/questions/${encodeURIComponent(questionId)}/dismiss`),
  agents: (workspaceId: string) => call<Agent[]>("GET", `${ws(workspaceId)}/agents`),
  createAgent: (workspaceId: string, name: string) => call<Agent>("POST", `${ws(workspaceId)}/agents`, { name }),
  renameAgent: (id: string, name: string) => call<Agent>("PATCH", agent(id), { name }),
  setAgentRunner: (id: string, runnerId: string | null) => call<Agent>("PATCH", agent(id), { runnerId }),
  runners: () => call<Runner[]>("GET", "/api/runners"),
  createRunner: (input: { name: string; kind: string }) => call<Runner>("POST", "/api/runners", input),
  setRunnerLimit: (id: string, limit: number) => call<Runner>("PATCH", runner(id), { limit }),
  saveTrigger: (runnerId: string, input: { model: string; projectId: string | null; triggerId: string; token: string }) =>
    call<Runner>("POST", `${runner(runnerId)}/triggers`, input),
  removeTrigger: (runnerId: string, triggerId: string) =>
    call<Runner>("DELETE", `${runner(runnerId)}/triggers/${encodeURIComponent(triggerId)}`),
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
  retry: (ticketId: string) => call<Ticket>("POST", `/api/tickets/${encodeURIComponent(ticketId)}/retry`),
  dismiss: (ticketId: string) => call<Ticket>("POST", `/api/tickets/${encodeURIComponent(ticketId)}/dismiss`),
  connectRequest: (requestId: string) => call<ConnectRequest>("GET", connect(requestId)),
  approveConnect: (requestId: string, agentId: string) =>
    call<{ redirectTo: string }>("POST", `${connect(requestId)}/approve`, { agentId }),
  denyConnect: (requestId: string) => call<{ redirectTo: string }>("POST", `${connect(requestId)}/deny`),
  completion: (ticketId: string) =>
    call<Completion | null>("GET", `/api/tickets/${encodeURIComponent(ticketId)}/completion`),
  pullRequests: (ticketId: string) =>
    call<PullRequest[]>("GET", `/api/tickets/${encodeURIComponent(ticketId)}/pull-requests`),
  linkedDocuments: (ticketId: string) =>
    call<LinkedDocument[]>("GET", `/api/tickets/${encodeURIComponent(ticketId)}/documents`),
  linkDocument: (ticketId: string, documentId: string) =>
    call<LinkedDocument>("POST", `/api/tickets/${encodeURIComponent(ticketId)}/documents`, { documentId }),
  unlinkDocument: (ticketId: string, documentId: string) =>
    call<void>("DELETE", `/api/tickets/${encodeURIComponent(ticketId)}/documents/${encodeURIComponent(documentId)}`),
  documents: (tree: Tree) => call<DocumentSummary[]>("GET", treePath(tree)),
  createDocument: (tree: Tree, input: { title: string; body?: string; parentId?: string | null }) =>
    call<Document>("POST", treePath(tree), input),
  document: (id: string) => call<Document>("GET", doc(id)),
  editDocument: (id: string, edit: DocumentEdit) => call<Document>("PATCH", doc(id), edit),
  deleteDocument: (id: string) => call<void>("DELETE", doc(id)),
  versions: (documentId: string) => call<Version[]>("GET", `${doc(documentId)}/versions`),
  version: (documentId: string, number: number) => call<VersionWithBody>("GET", `${doc(documentId)}/versions/${number}`),
  compareVersions: (documentId: string, from: number, to: number) =>
    call<Comparison>("GET", `${doc(documentId)}/versions/compare?from=${from}&to=${to}`),
  terms: (place: Place) => call<Term[]>("GET", `${placePath(place)}/terms`),
  glossary: (projectId: string) => call<Term[]>("GET", `/api/projects/${encodeURIComponent(projectId)}/glossary`),
  createTerm: (place: Place, input: TermContent) => call<Term>("POST", `${placePath(place)}/terms`, input),
  term: (id: string) => call<Term>("GET", term(id)),
  editTerm: (id: string, edit: Partial<TermContent> & { baseVersion: number }) => call<Term>("PATCH", term(id), edit),
  deleteTerm: (id: string) => call<void>("DELETE", term(id)),
  termVersions: (termId: string) => call<TermVersion[]>("GET", `${term(termId)}/versions`),
  termVersion: (termId: string, number: number) => call<TermVersion>("GET", `${term(termId)}/versions/${number}`),
  compareTermVersions: (termId: string, from: number, to: number) =>
    call<TermComparison>("GET", `${term(termId)}/versions/compare?from=${from}&to=${to}`),
  attachments: (owner: AttachmentOwner) => call<Attachment[]>("GET", attachmentsPath(owner)),
  attach: (owner: AttachmentOwner, file: File) =>
    call<Attachment>("POST", `${attachmentsPath(owner)}?name=${encodeURIComponent(file.name)}`, file),
  removeAttachment: (id: string) => call<void>("DELETE", `/api/attachments/${encodeURIComponent(id)}`),
  decisions: (place: Place) => call<DecisionSummary[]>("GET", `${placePath(place)}/decisions`),
  createDecision: (place: Place, input: { title: string; body?: string }) =>
    call<Decision>("POST", `${placePath(place)}/decisions`, input),
  decision: (id: string) => call<Decision>("GET", decision(id)),
  editDecision: (id: string, edit: DecisionEdit) => call<Decision>("PATCH", decision(id), edit),
  decisionVersions: (id: string) => call<DecisionVersion[]>("GET", `${decision(id)}/versions`),
  decisionVersion: (id: string, number: number) =>
    call<DecisionVersion & { body: string }>("GET", `${decision(id)}/versions/${number}`),
  compareDecisionVersions: (id: string, from: number, to: number) =>
    call<Comparison>("GET", `${decision(id)}/versions/compare?from=${from}&to=${to}`),
  timeline: (ticketId: string) => call<Change[]>("GET", `/api/tickets/${encodeURIComponent(ticketId)}/timeline`),
};

function treePath(tree: Tree) {
  return `${placePath(tree)}/documents`;
}

function placePath(place: Place) {
  return place.kind === "project" ? `/api/projects/${encodeURIComponent(place.id)}` : ws(place.id);
}

function term(id: string) {
  return `/api/terms/${encodeURIComponent(id)}`;
}

function attachmentsPath(owner: AttachmentOwner) {
  return `/api/${owner.kind}s/${encodeURIComponent(owner.id)}/attachments`;
}

function decision(id: string) {
  return `/api/decisions/${encodeURIComponent(id)}`;
}

function doc(id: string) {
  return `/api/documents/${encodeURIComponent(id)}`;
}

function runner(id: string) {
  return `/api/runners/${encodeURIComponent(id)}`;
}

function ws(id: string) {
  return `/api/workspaces/${encodeURIComponent(id)}`;
}

function connect(requestId: string) {
  return `/api/oauth/requests/${encodeURIComponent(requestId)}`;
}

function agent(id: string) {
  return `/api/agents/${encodeURIComponent(id)}`;
}
