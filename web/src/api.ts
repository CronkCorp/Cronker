/** A thin client for Cronk's HTTP API. The web client holds no rules of its own. */

// Every response type is the server's own, from its schemas: type-only, so no server code reaches the browser bundle
// (the build refuses any that does). Screens import them from here. What this module holds itself is the `fetch`
// plumbing, the error type, the request shapes the server has no schema for, and the calls.
import type { Agent, AgentCreate, AgentEdit } from "../../server/agents/agents.js";
import type { AgentRecord, RecordEntry } from "../../server/agents/record.js";
import type { AgentToken, IssuedToken, TokenAccess } from "../../server/agents/tokens.js";
import type {
  Artifact,
  ArtifactComparison,
  ArtifactFile,
  ArtifactSummary,
  ArtifactVersion,
  ComparedFile,
} from "../../server/artifacts/artifacts.js";
import type { ArtifactLink, LinkedArtifact } from "../../server/artifacts/linked-artifacts.js";
import type { Attachment, Owner as AttachmentOwner } from "../../server/attachments/attachments.js";
import type { GitHubApp, ManifestStart } from "../../server/github/app.js";
import type { Import as GitHubImport } from "../../server/github/importing.js";
import type { Installation as GitHubInstallation } from "../../server/github/installations.js";
import type { Check, PullRequest } from "../../server/github/pull-requests.js";
import type { Repository } from "../../server/github/repositories.js";
import type { Checklist as GitHubChecklist } from "../../server/github/upgrade.js";
import type { Link, LinkDetails } from "../../server/identity/links.js";
import type { User } from "../../server/identity/user.js";
import type { Inbox, InboxItem } from "../../server/inbox/inbox.js";
import type { ComparedLine } from "../../server/knowledge/compare.js";
import type {
  Decision,
  DecisionComparison,
  DecisionCreate,
  DecisionEdit,
  DecisionStatus,
  DecisionSummary,
  DecisionVersion,
  DecisionVersionWithBody,
} from "../../server/knowledge/decisions.js";
import type {
  Comparison,
  Document,
  DocumentCreate,
  DocumentEdit,
  DocumentSummary,
  Version,
  VersionWithBody,
} from "../../server/knowledge/documents.js";
import type { DocumentLink, LinkedDocument } from "../../server/knowledge/linked-documents.js";
import type { ReportRef } from "../../server/knowledge/reports.js";
import type { LinkedDocumentWithThreads, ReportWithThreads as Report } from "../../server/knowledge/ticket-threads.js";
import type { Term, TermComparison, TermCreate, TermDetail, TermEdit, TermVersion } from "../../server/knowledge/terms.js";
import type { AuthorizationRequest as ConnectRequest } from "../../server/oauth/authorizations.js";
import type { Brief } from "../../server/runs/brief.js";
import type { Cost } from "../../server/runs/costs.js";
import type { RoutinePlan, StartedSetup } from "../../server/runs/runner-setups.js";
import type { RunnerRecord as Runner, Trigger } from "../../server/runs/runners.js";
import type { Run } from "../../server/runs/runs.js";
import type { RunState } from "../../server/runs/states.js";
import type { SearchKind, SearchResult } from "../../server/search/search.js";
import type { KeyMention, MentionCandidate } from "../../server/work/draft-mentions.js";
import type { TranscriptHook } from "../../server/transcripts/hook.js";
import type { EntryPage, TicketTranscript, Transcript, TranscriptEntry } from "../../server/transcripts/transcripts.js";
import type { AccessPreview, ListedUser, ProjectAccess } from "../../server/work/access.js";
import type { Actor, ActorOrCronk } from "../../server/work/actors.js";
import type { Change } from "../../server/work/changes.js";
import type { Comment, CommentCreate, DocumentCommentCreate } from "../../server/work/comments.js";
import type { ArtifactMention, DecisionMention, Mention, TermMention, TicketMention } from "../../server/work/mentions.js";
import type { Project, ProjectSummary, Status, StatusKind, Visibility } from "../../server/work/projects.js";
import type { Relation, RelationCreate, RelationKind, TicketRelations } from "../../server/work/relations.js";
import type { LabelRule, Outcome, Step, StepKind } from "../../server/work/steps.js";
import type {
  MentioningText,
  Priority,
  Ticket,
  TicketCreate,
  TicketEdit,
  TicketList,
  TicketRef,
  TicketSummary,
} from "../../server/work/tickets.js";
import type { Completion, MovedOnDependent, ReopenPreview, TicketReopen } from "../../server/work/verification.js";
import type { AddedMember, Member, MemberAdd, MemberAddByGitHub, MemberEdit, PendingAdd } from "../../server/workspaces/members.js";
import type {
  AgentAccess,
  Membership as WorkspaceSummary,
  Workspace,
  WorkspaceCreate,
  WorkspaceRename,
  WorkspaceSettings,
  WorkspaceSettingsEdit,
} from "../../server/workspaces/workspaces.js";
// The request types of the other areas' calls, from each route's body schema.
import type { TokenIssue } from "../../server/agents/tokens.js";
import type { ManifestRequest } from "../../server/github/app.js";
import type { PullRequestLink } from "../../server/github/manual-links.js";
import type { RepositoryAdd } from "../../server/github/repositories.js";
import type { LinkLookup, LinkUse } from "../../server/identity/links.js";
import type { SetupInput } from "../../server/identity/setup.js";
import type { MeEdit, PasswordChange, SignIn } from "../../server/identity/sign-ins.js";
import type { RequestApproval } from "../../server/oauth/authorizations.js";
import type { SetupStart } from "../../server/runs/runner-setups.js";
import type { RunnerCreate, RunnerEdit, TriggerSave, TriggerToken, WebhookSecret } from "../../server/runs/runners.js";
import type { RedactionCreate } from "../../server/transcripts/transcripts.js";
import type { ProjectCreate, ProjectEdit } from "../../server/work/projects.js";
import type { StatusAdd, StatusEdit } from "../../server/work/statuses.js";
import type { StepPut } from "../../server/work/steps.js";
import type { Webhook, WebhookCreate, WebhookDelivery, WebhookEdit, WebhookKind } from "../../server/webhooks/webhooks.js";

export type { KeyMention, MentionCandidate };
export type { ArtifactMention, Change, Comment, Cost, DecisionMention, Mention, MentioningText, TermMention, TicketMention, Priority, Relation, RelationKind, Report, RunState };
export type { Ticket, TicketList, TicketRef, TicketRelations, TicketSummary };
export type { CommentCreate, RelationCreate, TicketCreate, TicketEdit, TicketReopen };
export type { ProjectCreate, ProjectEdit, StatusAdd, StatusEdit, StepPut, SetupInput, WorkspaceCreate, WorkspaceSettingsEdit };
export type { DecisionCreate, DecisionEdit, DocumentCreate, DocumentEdit, TermCreate, TermEdit };
export type { AgentAccess, Link, LinkDetails, Member, PendingAdd, User, Workspace, WorkspaceSettings, WorkspaceSummary };
export type { LabelRule, ListedUser, Outcome, Project, ProjectAccess, ProjectSummary, Status, StatusKind, Step, StepKind, Visibility };
export type { Agent, AgentRecord, AgentToken, RecordEntry, Brief, RoutinePlan, Run, Runner, StartedSetup, TokenAccess, Trigger };
export type { TicketTranscript, Transcript, TranscriptEntry, TranscriptHook };
export type { Actor, Attachment, AttachmentOwner };
export type { ComparedLine, Comparison, Document, DocumentSummary, LinkedDocument, ReportRef, Version, VersionWithBody };
export type { Term, TermComparison, TermDetail, TermVersion };
export type { Decision, DecisionComparison, DecisionStatus, DecisionSummary, DecisionVersion, DecisionVersionWithBody };
export type { Artifact, ArtifactComparison, ArtifactFile, ArtifactSummary, ArtifactVersion, ComparedFile, LinkedArtifact };
export type { Check, Completion, MovedOnDependent, GitHubApp, GitHubChecklist, GitHubImport, GitHubInstallation, PullRequest, Repository };
export type { ConnectRequest, Inbox, InboxItem, SearchKind, SearchResult };
export type { Webhook, WebhookDelivery, WebhookKind };

/** Who made a Change or wrote a Comment: a User, an Agent, or Cronk itself. */
export type ChangeActor = ActorOrCronk;

/** How to show a User: their display name, else their email, else their GitHub login. */
export function nameOf(user: User): string {
  return user.displayName ?? user.email ?? `@${user.githubLogin}`;
}

export const statusKinds: { kind: StatusKind; label: string }[] = [
  { kind: "backlog", label: "Backlog" },
  { kind: "active", label: "Active" },
  { kind: "review", label: "Review" },
  { kind: "done", label: "Done" },
  { kind: "canceled", label: "Canceled" },
];

/** How a Label rule reads, such as `skipped by no-review`. */
export const labelRuleShown = ({ kind, label }: LabelRule) =>
  kind === "requires" ? `requires ${label}` : `skipped by ${label}`;

export const priorities: { priority: Priority; label: string }[] = [
  { priority: "urgent", label: "Urgent" },
  { priority: "high", label: "High" },
  { priority: "medium", label: "Medium" },
  { priority: "low", label: "Low" },
  { priority: "none", label: "None" },
];

export interface TicketFilter {
  statusId?: string;
  assigneeId?: string;
  priority?: Priority;
  label?: string;
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

/** Which page tree: a Project's, or the Workspace's. */
export type Tree = { kind: "project"; id: string } | { kind: "workspace"; id: string };

/** Where knowledge is kept: a Project, or the Workspace. */
export type Place = Tree;

export const decisionStatuses = ["proposed", "accepted", "rejected", "deprecated", "superseded"] as const satisfies readonly DecisionStatus[];

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
  setUp: (input: SetupInput) =>
    call<{ user: User; workspace: Workspace }>("POST", "/api/setup", input),
  signIn: (email: string, password: string) => call<{ user: User }>("POST", "/api/sign-in", { email, password } satisfies SignIn),
  signOut: () => call<void>("DELETE", "/api/sign-in"),
  me: () => call<{ user: User; workspaces: WorkspaceSummary[] }>("GET", "/api/me"),
  changeDisplayName: (displayName: string | null) => call<{ user: User }>("PATCH", "/api/me", { displayName } satisfies MeEdit),
  changePassword: (currentPassword: string, newPassword: string) =>
    call<void>("PUT", "/api/me/password", { currentPassword, newPassword } satisfies PasswordChange),
  workspace: (id: string) => call<Workspace>("GET", ws(id)),
  createWorkspace: (input: WorkspaceCreate) => call<WorkspaceSummary>("POST", "/api/workspaces", input),
  renameWorkspace: (id: string, name: string) => call<Workspace>("PATCH", ws(id), { name } satisfies WorkspaceRename),
  workspaceSettings: (id: string) => call<WorkspaceSettings>("GET", `${ws(id)}/settings`),
  changeWorkspaceSettings: (id: string, change: WorkspaceSettingsEdit) =>
    call<WorkspaceSettings>("PATCH", `${ws(id)}/settings`, change),
  members: (id: string) => call<Member[]>("GET", `${ws(id)}/members`),
  addMember: (id: string, email: string) =>
    call<AddedMember>("POST", `${ws(id)}/members`, { email } satisfies MemberAdd),
  setAdmin: (id: string, userId: string, isAdmin: boolean) =>
    call<Member>("PATCH", `${ws(id)}/members/${encodeURIComponent(userId)}`, { isAdmin } satisfies MemberEdit),
  removeMember: (id: string, userId: string) => call<void>("DELETE", `${ws(id)}/members/${encodeURIComponent(userId)}`),
  pendingAdds: (id: string) => call<PendingAdd[]>("GET", `${ws(id)}/pending-adds`),
  cancelPendingAdd: (id: string, userId: string) =>
    call<void>("DELETE", `${ws(id)}/pending-adds/${encodeURIComponent(userId)}`),
  resetLink: (id: string, userId: string) => call<Link>("POST", `${ws(id)}/members/${encodeURIComponent(userId)}/reset-link`),
  addMemberByGitHub: (id: string, login: string) =>
    call<{ user: User }>("POST", `${ws(id)}/members/github`, { login } satisfies MemberAddByGitHub),
  githubApp: () => call<{ app: GitHubApp | null }>("GET", "/api/github/app").then((r) => r.app),
  githubChecklist: () => call<GitHubChecklist>("GET", "/api/github/app/checklist"),
  /** What Cronk keeps of the App's installations, or with `refresh` what GitHub says now. */
  githubInstallations: (refresh = false) =>
    call<GitHubInstallation[]>("GET", `/api/github/installations${refresh ? "?refresh=true" : ""}`),
  startGitHubApp: (githubOrganization?: string) =>
    call<ManifestStart>("POST", "/api/github/app/manifest", { githubOrganization } satisfies ManifestRequest),
  lookUpLink: (token: string) => call<LinkDetails>("POST", "/api/links/lookup", { token } satisfies LinkLookup),
  useLink: (token: string, password: string) => call<{ user: User }>("POST", "/api/links/use", { token, password } satisfies LinkUse),
  projects: (workspaceId: string) =>
    call<ProjectSummary[]>("GET", `/api/workspaces/${encodeURIComponent(workspaceId)}/projects`),
  createProject: (workspaceId: string, input: ProjectCreate) =>
    call<Project>("POST", `/api/workspaces/${encodeURIComponent(workspaceId)}/projects`, input),
  project: (id: string) => call<Project>("GET", `/api/projects/${encodeURIComponent(id)}`),
  editProject: (id: string, edit: ProjectEdit) =>
    call<Project>("PATCH", `/api/projects/${encodeURIComponent(id)}`, edit),
  archiveProject: (id: string) => call<Project>("POST", `/api/projects/${encodeURIComponent(id)}/archive`),
  unarchiveProject: (id: string) => call<Project>("POST", `/api/projects/${encodeURIComponent(id)}/unarchive`),
  projectAccess: (id: string) => call<ProjectAccess>("GET", `/api/projects/${encodeURIComponent(id)}/access`),
  setProjectAccess: (id: string, access: ProjectAccess) =>
    call<ProjectAccess>("PUT", `/api/projects/${encodeURIComponent(id)}/access`, access),
  /** How many Tickets setting the Access would unassign or undelegate, changing nothing. */
  previewProjectAccess: (id: string, access: ProjectAccess) =>
    call<AccessPreview>("POST", `/api/projects/${encodeURIComponent(id)}/access/preview`, access),
  repositories: (projectId: string) => call<Repository[]>("GET", `/api/projects/${encodeURIComponent(projectId)}/repositories`),
  addRepository: (projectId: string, id: number) =>
    call<Repository>("POST", `/api/projects/${encodeURIComponent(projectId)}/repositories`, { id } satisfies RepositoryAdd),
  removeRepository: (projectId: string, id: number) =>
    call<void>("DELETE", `/api/projects/${encodeURIComponent(projectId)}/repositories/${id}`),
  startImport: (projectId: string, repositoryId: number) =>
    call<GitHubImport>("POST", `/api/projects/${encodeURIComponent(projectId)}/repositories/${repositoryId}/import`),
  latestImport: (projectId: string, repositoryId: number) =>
    call<{ import: GitHubImport | null }>("GET", `/api/projects/${encodeURIComponent(projectId)}/repositories/${repositoryId}/import`),
  addStatus: (projectId: string, input: StatusAdd) =>
    call<Project>("POST", `/api/projects/${encodeURIComponent(projectId)}/statuses`, input),
  editStatus: (projectId: string, statusId: string, input: StatusEdit) =>
    call<Project>(
      "PATCH",
      `/api/projects/${encodeURIComponent(projectId)}/statuses/${encodeURIComponent(statusId)}`,
      input,
    ),
  removeStatus: (projectId: string, statusId: string) =>
    call<Project>("DELETE", `/api/projects/${encodeURIComponent(projectId)}/statuses/${encodeURIComponent(statusId)}`),
  putStep: (projectId: string, statusId: string, step: StepPut) =>
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
    return call<TicketList>("GET", `/api/projects/${encodeURIComponent(projectId)}/tickets${search}`);
  },
  createTicket: (projectId: string, input: TicketCreate) =>
    call<Ticket>("POST", `/api/projects/${encodeURIComponent(projectId)}/tickets`, input),
  ticket: (id: string) => call<Ticket>("GET", `/api/tickets/${encodeURIComponent(id)}`),
  editTicket: (id: string, edit: TicketEdit) => call<Ticket>("PATCH", `/api/tickets/${encodeURIComponent(id)}`, edit),
  acceptTicket: (id: string) => call<Ticket>("POST", `/api/tickets/${encodeURIComponent(id)}/accept`),
  mergeTicket: (id: string) => call<Ticket>("POST", `/api/tickets/${encodeURIComponent(id)}/merge`),
  removeFromQueue: (id: string) => call<Ticket>("POST", `/api/tickets/${encodeURIComponent(id)}/queue/remove`),
  reopenTicket: (id: string, comment: string, sendBack: string[] = []) =>
    call<Ticket>("POST", `/api/tickets/${encodeURIComponent(id)}/reopen`, { comment, sendBack } satisfies TicketReopen),
  comments: (ticketId: string) => call<Comment[]>("GET", `/api/tickets/${encodeURIComponent(ticketId)}/comments`),
  comment: (ticketId: string, input: CommentCreate) =>
    call<Comment>("POST", `/api/tickets/${encodeURIComponent(ticketId)}/comments`, input),
  artifactComments: (artifactId: string) =>
    call<Comment[]>("GET", `/api/artifacts/${encodeURIComponent(artifactId)}/comments`),
  commentOnArtifact: (artifactId: string, input: CommentCreate) =>
    call<Comment>("POST", `/api/artifacts/${encodeURIComponent(artifactId)}/comments`, input),
  /** A Document's Comments, its resolved threads included, as its Comments panel hides or shows them. */
  documentComments: (documentId: string) =>
    call<Comment[]>("GET", `/api/documents/${encodeURIComponent(documentId)}/comments?resolved=true`),
  resolveComment: (commentId: string) =>
    call<Comment>("POST", `/api/comments/${encodeURIComponent(commentId)}/resolve`),
  unresolveComment: (commentId: string) =>
    call<Comment>("POST", `/api/comments/${encodeURIComponent(commentId)}/unresolve`),
  commentOnDocument: (documentId: string, input: DocumentCommentCreate) =>
    call<Comment>("POST", `/api/documents/${encodeURIComponent(documentId)}/comments`, input),
  reports: (ticketId: string) => call<Report[]>("GET", `/api/tickets/${encodeURIComponent(ticketId)}/reports`),
  inbox: (workspaceId: string) => call<Inbox>("GET", `${ws(workspaceId)}/inbox`),
  dismissQuestion: (questionId: string) => call<void>("POST", `/api/questions/${encodeURIComponent(questionId)}/dismiss`),
  agents: (workspaceId: string) => call<Agent[]>("GET", `${ws(workspaceId)}/agents`),
  createAgent: (workspaceId: string, name: string) => call<Agent>("POST", `${ws(workspaceId)}/agents`, { name } satisfies AgentCreate),
  renameAgent: (id: string, name: string) => call<Agent>("PATCH", agent(id), { name } satisfies AgentEdit),
  setAgentRunner: (id: string, runnerId: string | null) => call<Agent>("PATCH", agent(id), { runnerId } satisfies AgentEdit),
  runners: () => call<Runner[]>("GET", "/api/runners"),
  createRunner: (input: RunnerCreate) => call<Runner>("POST", "/api/runners", input),
  setRunnerLimit: (id: string, limit: number) => call<Runner>("PATCH", runner(id), { limit } satisfies RunnerEdit),
  setBudgetPerRun: (id: string, budgetPerRun: Exclude<RunnerEdit["budgetPerRun"], undefined>) => call<Runner>("PATCH", runner(id), { budgetPerRun } satisfies RunnerEdit),
  removeRunner: (id: string) => call<void>("DELETE", runner(id)),
  saveWebhookSecret: (id: string, secret: string) => call<Runner>("PUT", `${runner(id)}/webhook-secret`, { secret } satisfies WebhookSecret),
  forgetWebhookSecret: (id: string) => call<Runner>("DELETE", `${runner(id)}/webhook-secret`),
  saveTrigger: (runnerId: string, input: TriggerSave) =>
    call<Runner>("POST", `${runner(runnerId)}/triggers`, input),
  pasteTriggerToken: (runnerId: string, triggerId: string, token: string) =>
    call<Runner>("PUT", `${runner(runnerId)}/triggers/${encodeURIComponent(triggerId)}/token`, { token } satisfies TriggerToken),
  startRunnerSetup: (runnerId: string, input: SetupStart) =>
    call<StartedSetup>("POST", `${runner(runnerId)}/setups`, input),
  removeTrigger: (runnerId: string, triggerId: string) =>
    call<Runner>("DELETE", `${runner(runnerId)}/triggers/${encodeURIComponent(triggerId)}`),
  removeAgent: (id: string) => call<void>("DELETE", agent(id)),
  webhooks: (workspaceId: string) => call<Webhook[]>("GET", webhooksOf(workspaceId)),
  createWebhook: (workspaceId: string, input: WebhookCreate) =>
    call<Webhook & { secret: string }>("POST", webhooksOf(workspaceId), input),
  editWebhook: (workspaceId: string, id: string, input: WebhookEdit) =>
    call<Webhook>("PATCH", `${webhooksOf(workspaceId)}/${encodeURIComponent(id)}`, input),
  removeWebhook: (workspaceId: string, id: string) => call<void>("DELETE", `${webhooksOf(workspaceId)}/${encodeURIComponent(id)}`),
  testWebhook: (workspaceId: string, id: string) =>
    call<WebhookDelivery>("POST", `${webhooksOf(workspaceId)}/${encodeURIComponent(id)}/test`),
  webhookDeliveries: (workspaceId: string, id: string) =>
    call<WebhookDelivery[]>("GET", `${webhooksOf(workspaceId)}/${encodeURIComponent(id)}/deliveries`),
  tokens: (agentId: string) => call<AgentToken[]>("GET", `${agent(agentId)}/tokens`),
  issueToken: (agentId: string, input: TokenIssue) =>
    call<IssuedToken>("POST", `${agent(agentId)}/tokens`, input),
  revokeToken: (agentId: string, tokenId: string) =>
    call<void>("DELETE", `${agent(agentId)}/tokens/${encodeURIComponent(tokenId)}`),
  relations: (ticketId: string) =>
    call<TicketRelations>("GET", `/api/tickets/${encodeURIComponent(ticketId)}/relations`),
  relate: (ticketId: string, input: RelationCreate) =>
    call<Relation>("POST", `/api/tickets/${encodeURIComponent(ticketId)}/relations`, input),
  removeRelation: (ticketId: string, relationId: string) =>
    call<void>("DELETE", `/api/tickets/${encodeURIComponent(ticketId)}/relations/${encodeURIComponent(relationId)}`),
  runs: (ticketId: string) => call<Run[]>("GET", `/api/tickets/${encodeURIComponent(ticketId)}/runs`),
  run: (id: string) => call<Run>("GET", `/api/runs/${encodeURIComponent(id)}`),
  transcriptHook: () => call<TranscriptHook>("GET", "/api/transcript-hook"),
  transcript: (id: string) => call<Transcript>("GET", `/api/transcripts/${encodeURIComponent(id)}`),
  agentRecord: (agentId: string, before?: string) =>
    call<AgentRecord>(
      "GET",
      `/api/agents/${encodeURIComponent(agentId)}/record${before === undefined ? "" : `?before=${encodeURIComponent(before)}`}`,
    ),
  agentTranscripts: (agentId: string) =>
    call<Transcript[]>("GET", `/api/agents/${encodeURIComponent(agentId)}/transcripts`),
  ticketTranscripts: (ticketId: string) =>
    call<TicketTranscript[]>("GET", `/api/tickets/${encodeURIComponent(ticketId)}/transcripts`),
  transcriptEntries: (id: string, after?: number) =>
    call<EntryPage>(
      "GET",
      `/api/transcripts/${encodeURIComponent(id)}/entries${after === undefined ? "" : `?after=${after}`}`,
    ),
  deleteTranscript: (id: string) => call<void>("DELETE", `/api/transcripts/${encodeURIComponent(id)}`),
  redactTranscript: (id: string, text: string) =>
    call<Transcript>("POST", `/api/transcripts/${encodeURIComponent(id)}/redactions`, { text } satisfies RedactionCreate),
  retry: (ticketId: string) => call<Ticket>("POST", `/api/tickets/${encodeURIComponent(ticketId)}/retry`),
  dismiss: (ticketId: string) => call<Ticket>("POST", `/api/tickets/${encodeURIComponent(ticketId)}/dismiss`),
  connectRequest: (requestId: string) => call<ConnectRequest>("GET", connect(requestId)),
  approveConnect: (requestId: string, agentId: string) =>
    call<{ redirectTo: string }>("POST", `${connect(requestId)}/approve`, { agentId } satisfies RequestApproval),
  denyConnect: (requestId: string) => call<{ redirectTo: string }>("POST", `${connect(requestId)}/deny`),
  completion: (ticketId: string) =>
    call<Completion | null>("GET", `/api/tickets/${encodeURIComponent(ticketId)}/completion`),
  reopenPreview: (ticketId: string) =>
    call<ReopenPreview>("GET", `/api/tickets/${encodeURIComponent(ticketId)}/reopen-preview`),
  pullRequests: (ticketId: string) =>
    call<PullRequest[]>("GET", `/api/tickets/${encodeURIComponent(ticketId)}/pull-requests`),
  linkPullRequest: (ticketId: string, pullRequest: string) =>
    call<PullRequest>("POST", `/api/tickets/${encodeURIComponent(ticketId)}/pull-requests`, { pullRequest } satisfies PullRequestLink),
  unlinkPullRequest: (ticketId: string, pullRequestId: number) =>
    call<void>("DELETE", `/api/tickets/${encodeURIComponent(ticketId)}/pull-requests/${pullRequestId}`),
  linkedDocuments: (ticketId: string) =>
    call<LinkedDocumentWithThreads[]>("GET", `/api/tickets/${encodeURIComponent(ticketId)}/documents`),
  linkDocument: (ticketId: string, documentId: string) =>
    call<LinkedDocument>("POST", `/api/tickets/${encodeURIComponent(ticketId)}/documents`, { documentId } satisfies DocumentLink),
  unlinkDocument: (ticketId: string, documentId: string) =>
    call<void>("DELETE", `/api/tickets/${encodeURIComponent(ticketId)}/documents/${encodeURIComponent(documentId)}`),
  documents: (tree: Tree) => call<DocumentSummary[]>("GET", treePath(tree)),
  createDocument: (tree: Tree, input: DocumentCreate) =>
    call<Document>("POST", treePath(tree), input),
  document: (id: string) => call<Document>("GET", doc(id)),
  artifact: (id: string, version?: number | null) =>
    call<Artifact>("GET", `/api/artifacts/${encodeURIComponent(id)}${version ? `?version=${version}` : ""}`),
  artifactVersions: (id: string) => call<ArtifactVersion[]>("GET", `/api/artifacts/${encodeURIComponent(id)}/versions`),
  compareArtifactVersions: (id: string, from: number, to: number) =>
    call<ArtifactComparison>("GET", `/api/artifacts/${encodeURIComponent(id)}/versions/compare?from=${from}&to=${to}`),
  deleteArtifact: (id: string) => call<void>("DELETE", `/api/artifacts/${encodeURIComponent(id)}`),
  deleteArtifactVersion: (id: string, number: number) =>
    call<void>("DELETE", `/api/artifacts/${encodeURIComponent(id)}/versions/${number}`),
  linkedArtifacts: (ticketId: string) =>
    call<LinkedArtifact[]>("GET", `/api/tickets/${encodeURIComponent(ticketId)}/artifacts`),
  linkArtifact: (ticketId: string, artifactId: string) =>
    call<LinkedArtifact>("POST", `/api/tickets/${encodeURIComponent(ticketId)}/artifacts`, { artifactId } satisfies ArtifactLink),
  unlinkArtifact: (ticketId: string, artifactId: string) =>
    call<void>("DELETE", `/api/tickets/${encodeURIComponent(ticketId)}/artifacts/${encodeURIComponent(artifactId)}`),
  editDocument: (id: string, edit: DocumentEdit) => call<Document>("PATCH", doc(id), edit),
  deleteDocument: (id: string) => call<void>("DELETE", doc(id)),
  versions: (documentId: string) => call<Version[]>("GET", `${doc(documentId)}/versions`),
  version: (documentId: string, number: number) => call<VersionWithBody>("GET", `${doc(documentId)}/versions/${number}`),
  compareVersions: (documentId: string, from: number, to: number) =>
    call<Comparison>("GET", `${doc(documentId)}/versions/compare?from=${from}&to=${to}`),
  terms: (place: Place) => call<Term[]>("GET", `${placePath(place)}/terms`),
  glossary: (projectId: string) => call<Term[]>("GET", `/api/projects/${encodeURIComponent(projectId)}/glossary`),
  createTerm: (place: Place, input: TermCreate) => call<TermDetail>("POST", `${placePath(place)}/terms`, input),
  term: (id: string) => call<TermDetail>("GET", term(id)),
  editTerm: (id: string, edit: TermEdit) => call<TermDetail>("PATCH", term(id), edit),
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
  artifacts: (place: Place) => call<ArtifactSummary[]>("GET", `${placePath(place)}/artifacts`),
  createDecision: (place: Place, input: DecisionCreate) =>
    call<Decision>("POST", `${placePath(place)}/decisions`, input),
  decision: (id: string) => call<Decision>("GET", decision(id)),
  editDecision: (id: string, edit: DecisionEdit) => call<Decision>("PATCH", decision(id), edit),
  decisionVersions: (id: string) => call<DecisionVersion[]>("GET", `${decision(id)}/versions`),
  decisionVersion: (id: string, number: number) =>
    call<DecisionVersionWithBody>("GET", `${decision(id)}/versions/${number}`),
  compareDecisionVersions: (id: string, from: number, to: number) =>
    call<DecisionComparison>("GET", `${decision(id)}/versions/compare?from=${from}&to=${to}`),
  search: (workspaceId: string, query: { q: string; project?: string }) =>
    call<SearchResult[]>(
      "GET",
      `/api/workspaces/${encodeURIComponent(workspaceId)}/search?${new URLSearchParams({ ...query })}`,
    ),
  /** What a draft mentions, as it would once saved in its place: a Project's text, or the Workspace's own. */
  draftMentions: (workspaceId: string, input: { markdown: string; project?: string }) =>
    call<KeyMention[]>("POST", `/api/workspaces/${encodeURIComponent(workspaceId)}/mentions`, input),
  /** What the editor's Mention picker offers for the word typed before the cursor. */
  mentionCandidates: (workspaceId: string, query: { q: string; project?: string }) =>
    call<MentionCandidate[]>(
      "GET",
      `/api/workspaces/${encodeURIComponent(workspaceId)}/mention-candidates?${new URLSearchParams({ ...query })}`,
    ),
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

function webhooksOf(workspaceId: string) {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/webhooks`;
}
