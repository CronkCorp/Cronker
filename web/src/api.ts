/** A thin client for Cronk's HTTP API. The web client holds no rules of its own. */

// The Ticket area's response and request types are the server's own, from its schemas: type-only, so no server code
// reaches the browser bundle (the build refuses any that does). Screens import them from here.
import type { ArtifactLink } from "../../server/artifacts/linked-artifacts.js";
import type { DecisionCreate, DecisionEdit } from "../../server/knowledge/decisions.js";
import type { DocumentCreate, DocumentEdit } from "../../server/knowledge/documents.js";
import type { DocumentLink } from "../../server/knowledge/linked-documents.js";
import type { Report } from "../../server/knowledge/reports.js";
import type { TermCreate, TermEdit } from "../../server/knowledge/terms.js";
import type { Cost } from "../../server/runs/costs.js";
import type { RunState } from "../../server/runs/states.js";
import type { ActorOrCronk } from "../../server/work/actors.js";
import type { Change } from "../../server/work/changes.js";
import type { Comment, CommentCreate } from "../../server/work/comments.js";
import type { ArtifactMention, Mention, TermMention, TicketMention } from "../../server/work/mentions.js";
import type { Relation, RelationCreate, RelationKind, TicketRelations } from "../../server/work/relations.js";
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
import type { TicketReopen } from "../../server/work/verification.js";

export type { ArtifactMention, Change, Comment, Cost, Mention, MentioningText, TermMention, TicketMention, Priority, Relation, RelationKind, Report, RunState };
export type { Ticket, TicketList, TicketRef, TicketRelations, TicketSummary };
export type { CommentCreate, RelationCreate, TicketCreate, TicketEdit, TicketReopen };
export type { DecisionCreate, DecisionEdit, DocumentCreate, DocumentEdit, TermCreate, TermEdit };

/** Who made a Change or wrote a Comment: a User, an Agent, or Cronk itself. */
export type ChangeActor = ActorOrCronk;

export interface User {
  id: string;
  /** Unknown for a User added by GitHub login until they first sign in. */
  email: string | null;
  githubLogin: string | null;
  /** The name the User chose to be shown by; null when they chose none. */
  displayName: string | null;
}

/** How to show a User: their display name, else their email, else their GitHub login. */
export function nameOf(user: User): string {
  return user.displayName ?? user.email ?? `@${user.githubLogin}`;
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

/** An import of a Repository's GitHub issues into a Project, running as a background job. */
export interface GitHubImport {
  id: string;
  repository: { id: number; fullName: string };
  state: "running" | "done" | "failed";
  imported: number;
  skipped: number;
  error: string | null;
  /** While it waits out GitHub's rate limit, when it carries on; null otherwise. */
  waitingUntil: string | null;
  startedBy: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  /** Its name in web addresses, such as `acme` in `/acme/tickets/RP-12`; it never changes. */
  slug: string;
  isAdmin: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
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

/** An ordinary Step, or a Merge Step, which skips itself unless an agent may merge the Ticket. */
export type StepKind = "ordinary" | "merge";

/** The agent work a Status asks for. */
export interface Step {
  kind: StepKind;
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

/** Whether a Project is open to every User of its Workspace or only to those it lists, and its Admins. */
export type Visibility = "open" | "private";

export interface ProjectSummary {
  id: string;
  workspaceId: string;
  name: string;
  key: string;
  visibility: Visibility;
  /** What the signed-in User may do in the Project; Read for everyone while it is archived. */
  access: "write" | "read";
  /** When an Admin archived it, making it read-only for everyone until unarchived; null if it isn't. */
  archivedAt: string | null;
  /** The Admin who archived it. */
  archivedBy: string | null;
}

/** Who may see a Project: open or private, and the Users it lists. Only Admins read and set it. */
export interface ProjectAccess {
  visibility: Visibility;
  users: { userId: string; level: "write" | "read" }[];
}

export interface Project extends ProjectSummary {
  newTicketsDelegated: boolean;
  /** Whether a Ticket takes Autonomous Delegation when first delegated. */
  autonomousDelegationDefault: boolean;
  /** Whether a merged Pull Request completes the Tickets it links. */
  pullRequestAutomation: boolean;
  /** Whether Merge Steps let agents merge Autonomous Delegation Tickets' Pull Requests; only Admins change it. */
  agentsMayMerge: boolean;
  /** Whether Briefs in this Project ask Runs to keep their Reports concise. */
  conciseReports: boolean;
  statuses: Status[];
}

/** The settings a User changes on a Project. */
export interface ProjectEdit {
  newTicketsDelegated?: boolean;
  autonomousDelegationDefault?: boolean;
  pullRequestAutomation?: boolean;
  agentsMayMerge?: boolean;
  conciseReports?: boolean;
}

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

export interface Agent {
  id: string;
  workspaceId: string;
  name: string;
  owner: User;
  runnerId: string | null;
  /** Whether its Runner runs in the cloud, so a `local-only` Ticket can't be delegated to it. */
  cloud: boolean;
  createdAt: string;
}

/** A subscription Runner's trigger: the claude.ai scheduled task it fires for one model label. Its token is never returned. */
export interface Trigger {
  id: string;
  model: string;
  /** The Project it overrides the Runner's own trigger on; null for all Projects. */
  projectId: string | null;
  triggerId: string;
  /** Saved without its token, or made by a Runner setup, and waiting for the token the Owner pastes; Runs needing it can't start until then. */
  waitingForToken: boolean;
  /** The routine's page in claude.ai, where its token is generated. */
  routineUrl: string;
  createdAt: string;
}

/** One routine a Runner setup has Claude Code create, for one model label the Project's board uses. */
export interface RoutinePlan {
  label: string;
  modelId: string;
  name: string;
  repositories: string[];
  prompt: string;
  mcpUrl: string;
  branchPrefix: string;
}

/** A Runner setup as it started: the command to paste into Claude Code, and what it creates. */
export interface StartedSetup {
  command: string;
  expiresAt: string;
  /** What the User gives up, such as Transcripts for a Project with several Repositories. */
  warning: string | null;
  plan: {
    project: { id: string; name: string; key: string };
    agent: { id: string; name: string };
    routines: RoutinePlan[];
  };
}

/** A way for Cronk to start Runs of the User's Agents with their own credentials. */
export interface Runner {
  id: string;
  name: string;
  kind: string;
  /** Whether its kind runs Runs in the cloud: a `local-only` Ticket gets no Run through it. */
  cloud: boolean;
  limit: number;
  /** How many of its Runs are running now, counted against its limit. */
  running: number;
  /** Until when a rate limit pauses its queue. */
  pausedUntil: string | null;
  triggers: Trigger[];
  /** For a `managed_agents` Runner, the agent definition and cloud environment Cronk created with its API key. */
  managedAgents: {
    agentId: string;
    environmentId: string;
    /** The webhook endpoint URL to add in the Anthropic Console. */
    webhookUrl: string;
    /** Whether the endpoint's signing secret is saved; without one, Runs end only by polling. */
    webhookSecretSaved: boolean;
  } | null;
  /** For a `managed_agents` Runner, the most each Run may cost, passed as each session's budget; null for none. */
  budgetPerRun: Cost | null;
  /** What its Runs that ended this calendar month cost, one total per currency. */
  costThisMonth: Cost[];
  createdAt: string;
}

/** How to install the Transcript hook: the `settings.json` snippet to commit, with this Cronk's address in it. */
export interface TranscriptHook {
  script: string;
  tokenVariable: string;
  settings: { hooks: Record<string, unknown> };
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
  /** What it cost, once it ended, where its Runner reports it; null for subscription Runs. */
  cost: Cost | null;
  /** Its Transcript, once one was uploaded for its session. */
  transcriptId: string | null;
  /** Its Transcript's readable form, for its address. */
  transcriptSlug: string | null;
  /** Whether a User deleted its Transcript. */
  transcriptDeleted: boolean;
  startedAt: string;
  endedAt: string | null;
}

/** The record of an agent's session, as Cronk converted it into entries. */
export interface Transcript {
  id: string;
  workspaceId: string;
  /** Its readable form, as its address takes it: its Agent's name, then its short id. */
  slug: string;
  sessionId: string;
  agent: { id: string; name: string };
  runId: string | null;
  /** For a session of no Run, the Tickets its Cronk tool calls name, in the order they first named them. */
  tickets: { id: string; key: string; title: string }[];
  entryCount: number;
  /** Where entries were left out of a Transcript past 50 MB: after which position, how many and how large. */
  gap: { after: number; entries: number; bytes: number } | null;
  uploadedAt: string;
  /** The Redactions Users added, oldest first: who and when, never the string redacted. */
  redactions: { id: string; addedBy: { id: string; name: string }; addedAt: string }[];
}

/** A Transcript as a Ticket it names lists it: placed when its Cronk tool calls first named the Ticket. */
export interface TicketTranscript extends Transcript {
  namedAt: string;
}

/** A message, or a tool call with its input and result, of a Transcript. */
export interface TranscriptEntry {
  position: number;
  role: "user" | "assistant" | "system";
  text: string | null;
  toolName: string | null;
  toolInput: unknown;
  toolResult: string | null;
  /** Whether any part of it was cut at 20 KB, keeping only the start; `cutParts` says which. */
  cut: boolean;
  /**
   * Which parts were cut at 20 KB: a tool call's input (then a string of its JSON's start) and its result, or the
   * text of a Transcript past 50 MB's last message over 25 MB alone.
   */
  cutParts: ("text" | "toolInput" | "toolResult")[];
  at: string | null;
}

/** A Report as lists show it, by its id and title. */
export interface ReportRef {
  id: string;
  title: string;
  /** Its readable form, as its address takes it: the words of its title, then its short id. */
  slug: string;
}

/** A Ticket in a Review Status, waiting for its Assignee's review. */
export interface ReviewItem {
  kind: "review";
  ticket: TicketSummary;
  status: { id: string; name: string };
  /** The Ticket's latest Report, or null when it has none. */
  report: ReportRef | null;
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
  /** The Ticket's latest Report, or null when it has none. */
  report: ReportRef | null;
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

/** A Ticket whose Assignee was removed from the Workspace or lost Write in its Project, waiting for an Admin to assign it. */
export interface ReassignItem {
  kind: "reassign";
  ticket: TicketSummary;
  formerAssignee: User;
  /** When it began waiting: when the Assignee of the Ticket was taken off it. */
  since: string;
}

export type InboxItem = QuestionItem | NeedsYouItem | ReviewItem | UnverifiedItem | RunItem | DiscoveredItem | ReassignItem;

/** A Workspace's settings beyond its name, set by its Admins. */
export interface WorkspaceSettings {
  lostRunMinutes: number;
  /** The exact model id each model label stands for, used by Runner setups. */
  modelIds: { label: string; modelId: string }[];
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
  /** Its readable form, as its address takes it: the words of its title, then its short id. */
  slug: string;
  version: Version;
}

export interface Document extends DocumentSummary {
  body: string;
  mentions: Mention[];
}

/** A file of an Artifact's Version, by its path relative to the Version. */
export interface ArtifactFile {
  path: string;
  mediaType: string;
  size: number;
}

/** A live page with its files, at its current Version, served sandboxed at `url`. */
export interface Artifact {
  id: string;
  workspaceId: string;
  /** Null for the Workspace's. */
  projectId: string | null;
  title: string;
  /** Its readable form, as its address takes it: the words of its title, then its short id. */
  slug: string;
  description: string;
  page: string;
  /** Where its page is served, sandboxed, on Cronk's own address. */
  url: string;
  version: { number: number; actor: Actor; savedAt: string };
  files: ArtifactFile[];
}

/** One saved state of an Artifact: who saved it and when. */
export interface ArtifactVersion {
  number: number;
  actor: Actor;
  savedAt: string;
}

/** A file that differs between two of an Artifact's Versions, its text compared line by line when it is text. */
export interface ComparedFile {
  path: string;
  change: "added" | "removed" | "changed";
  text: boolean;
  lines: ComparedLine[];
}

/** Two of an Artifact's Versions, with the files that differ between them. */
export interface ArtifactComparison {
  from: ArtifactVersion;
  to: ArtifactVersion;
  files: ComparedFile[];
}

/** An Artifact as its Project's or the Workspace's list shows it: without its files. */
export type ArtifactSummary = Omit<Artifact, "files">;

/** An Artifact linked to a Ticket, kept in its Project or the Workspace. */
export interface LinkedArtifact {
  id: string;
  /** Null for an Artifact of the Workspace. */
  projectId: string | null;
  title: string;
  /** Its readable form, as its address takes it: the words of its title, then its short id. */
  slug: string;
}

/** A Document linked to a Ticket, from its Project's page tree or the Workspace's. */
export interface LinkedDocument {
  id: string;
  /** Null for a Document of the Workspace's page tree. */
  projectId: string | null;
  title: string;
  /** Its readable form, as its address takes it: the words of its title, then its short id. */
  slug: string;
}

/** A check on a Pull Request's latest commit: a check run, or a commit status by its context. */
export interface Check {
  name: string;
  state: "pending" | "passed" | "failed" | "neutral";
  url: string | null;
}

/** A Pull Request linked to a Ticket by its key in the Pull Request's branch or title, or by hand by a User. */
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
  /**
   * Where its review stands: of each reviewer's latest review, dismissed ones aside, the latest requesting changes,
   * or else the latest approval; null when there is none.
   */
  reviewState: { state: "approved" | "changes_requested"; reviewer: string; url: string | null } | null;
  /** What last sent the Ticket back to its producing Step from this Pull Request, if anything did. */
  sentBack:
    | { kind: "check"; name: string; sha: string; url: string | null; at: string }
    | { kind: "review"; reviewer: string | null; url: string | null; at: string }
    | null;
  /** While it is open, GitHub's last answer that it conflicts with its base branch; null when it merges cleanly. */
  conflict: {
    branch: string;
    sha: string;
    merge: { repository: string; number: number; url: string } | null;
    at: string;
  } | null;
  /** Whether a User linked it by hand; only such a link can be unlinked. */
  manual: boolean;
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

/** A line of two texts compared: in both, only the earlier one, or only the later one. */
export interface ComparedLine {
  change: "same" | "removed" | "added";
  text: string;
}

export interface Comparison<V extends VersionWithBody = VersionWithBody> {
  from: V;
  to: V;
  lines: ComparedLine[];
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
  mentions: Mention[];
}

/** A Term read alone, with the texts mentioning it. */
export interface TermDetail extends Term {
  /** The other texts mentioning its name that the User may read, most recently saved first. */
  mentionedIn: MentioningText[];
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
  lines: ComparedLine[];
  avoid: ComparedLine[];
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
  mentions: Mention[];
}

/** An app's request to act in Cronk as one of the signed-in User's Agents, for the consent screen. */
export interface ConnectRequest {
  client: { id: string; name: string | null };
  redirectUri: string;
  agents: { id: string; name: string; workspace: { id: string; name: string } }[];
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

export type SearchKind = "ticket" | "document" | "report" | "term" | "decision" | "artifact" | "transcript";

export interface SearchResult {
  kind: SearchKind;
  id: string;
  title: string;
  projectId: string | null;
  /** A Ticket's own key, or the key of the Ticket a Report is on or a Transcript's Run was on. */
  ticketKey: string | null;
  /** A Document's, Report's, Artifact's or Transcript's readable form, for its address. */
  slug: string | null;
  /** A Decision's number, within its Project or among the Workspace's own. */
  number: number | null;
  /** Where it matched, the matching words marked. */
  snippet: { text: string; match: boolean }[];
}

export const api = {
  setupNeeded: () => call<{ needed: boolean }>("GET", "/api/setup").then((r) => r.needed),
  setUp: (input: { setupCode: string; email: string; password: string; workspaceName: string }) =>
    call<{ user: User; workspace: Workspace }>("POST", "/api/setup", input),
  signIn: (email: string, password: string) => call<{ user: User }>("POST", "/api/sign-in", { email, password }),
  signOut: () => call<void>("DELETE", "/api/sign-in"),
  me: () => call<{ user: User; workspaces: WorkspaceSummary[] }>("GET", "/api/me"),
  changeDisplayName: (displayName: string | null) => call<{ user: User }>("PATCH", "/api/me", { displayName }),
  changePassword: (currentPassword: string, newPassword: string) =>
    call<void>("PUT", "/api/me/password", { currentPassword, newPassword }),
  workspace: (id: string) => call<Workspace>("GET", ws(id)),
  createWorkspace: (input: { name: string; slug?: string }) => call<WorkspaceSummary>("POST", "/api/workspaces", input),
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
  /** What Cronk keeps of the App's installations, or with `refresh` what GitHub says now. */
  githubInstallations: (refresh = false) =>
    call<GitHubInstallation[]>("GET", `/api/github/installations${refresh ? "?refresh=true" : ""}`),
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
  archiveProject: (id: string) => call<Project>("POST", `/api/projects/${encodeURIComponent(id)}/archive`),
  unarchiveProject: (id: string) => call<Project>("POST", `/api/projects/${encodeURIComponent(id)}/unarchive`),
  projectAccess: (id: string) => call<ProjectAccess>("GET", `/api/projects/${encodeURIComponent(id)}/access`),
  setProjectAccess: (id: string, access: ProjectAccess) =>
    call<ProjectAccess>("PUT", `/api/projects/${encodeURIComponent(id)}/access`, access),
  /** How many Tickets setting the Access would unassign or undelegate, changing nothing. */
  previewProjectAccess: (id: string, access: ProjectAccess) =>
    call<{ tickets: number }>("POST", `/api/projects/${encodeURIComponent(id)}/access/preview`, access),
  repositories: (projectId: string) => call<Repository[]>("GET", `/api/projects/${encodeURIComponent(projectId)}/repositories`),
  addRepository: (projectId: string, id: number) =>
    call<Repository>("POST", `/api/projects/${encodeURIComponent(projectId)}/repositories`, { id }),
  removeRepository: (projectId: string, id: number) =>
    call<void>("DELETE", `/api/projects/${encodeURIComponent(projectId)}/repositories/${id}`),
  startImport: (projectId: string, repositoryId: number) =>
    call<GitHubImport>("POST", `/api/projects/${encodeURIComponent(projectId)}/repositories/${repositoryId}/import`),
  latestImport: (projectId: string, repositoryId: number) =>
    call<{ import: GitHubImport | null }>("GET", `/api/projects/${encodeURIComponent(projectId)}/repositories/${repositoryId}/import`),
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
    return call<TicketList>("GET", `/api/projects/${encodeURIComponent(projectId)}/tickets${search}`);
  },
  createTicket: (projectId: string, input: TicketCreate) =>
    call<Ticket>("POST", `/api/projects/${encodeURIComponent(projectId)}/tickets`, input),
  ticket: (id: string) => call<Ticket>("GET", `/api/tickets/${encodeURIComponent(id)}`),
  editTicket: (id: string, edit: TicketEdit) => call<Ticket>("PATCH", `/api/tickets/${encodeURIComponent(id)}`, edit),
  acceptTicket: (id: string) => call<Ticket>("POST", `/api/tickets/${encodeURIComponent(id)}/accept`),
  mergeTicket: (id: string) => call<Ticket>("POST", `/api/tickets/${encodeURIComponent(id)}/merge`),
  removeFromQueue: (id: string) => call<Ticket>("POST", `/api/tickets/${encodeURIComponent(id)}/queue/remove`),
  reopenTicket: (id: string, comment: string) =>
    call<Ticket>("POST", `/api/tickets/${encodeURIComponent(id)}/reopen`, { comment } satisfies TicketReopen),
  comments: (ticketId: string) => call<Comment[]>("GET", `/api/tickets/${encodeURIComponent(ticketId)}/comments`),
  comment: (ticketId: string, input: CommentCreate) =>
    call<Comment>("POST", `/api/tickets/${encodeURIComponent(ticketId)}/comments`, input),
  reports: (ticketId: string) => call<Report[]>("GET", `/api/tickets/${encodeURIComponent(ticketId)}/reports`),
  inbox: (workspaceId: string) => call<Inbox>("GET", `${ws(workspaceId)}/inbox`),
  dismissQuestion: (questionId: string) => call<void>("POST", `/api/questions/${encodeURIComponent(questionId)}/dismiss`),
  agents: (workspaceId: string) => call<Agent[]>("GET", `${ws(workspaceId)}/agents`),
  createAgent: (workspaceId: string, name: string) => call<Agent>("POST", `${ws(workspaceId)}/agents`, { name }),
  renameAgent: (id: string, name: string) => call<Agent>("PATCH", agent(id), { name }),
  setAgentRunner: (id: string, runnerId: string | null) => call<Agent>("PATCH", agent(id), { runnerId }),
  runners: () => call<Runner[]>("GET", "/api/runners"),
  createRunner: (input: { name: string; kind: string; apiKey?: string }) => call<Runner>("POST", "/api/runners", input),
  setRunnerLimit: (id: string, limit: number) => call<Runner>("PATCH", runner(id), { limit }),
  setBudgetPerRun: (id: string, budgetPerRun: Cost | null) => call<Runner>("PATCH", runner(id), { budgetPerRun }),
  removeRunner: (id: string) => call<void>("DELETE", runner(id)),
  saveWebhookSecret: (id: string, secret: string) => call<Runner>("PUT", `${runner(id)}/webhook-secret`, { secret }),
  forgetWebhookSecret: (id: string) => call<Runner>("DELETE", `${runner(id)}/webhook-secret`),
  saveTrigger: (runnerId: string, input: { model: string; projectId: string | null; triggerId: string; token?: string }) =>
    call<Runner>("POST", `${runner(runnerId)}/triggers`, input),
  pasteTriggerToken: (runnerId: string, triggerId: string, token: string) =>
    call<Runner>("PUT", `${runner(runnerId)}/triggers/${encodeURIComponent(triggerId)}/token`, { token }),
  startRunnerSetup: (runnerId: string, input: { projectId: string; agentId?: string }) =>
    call<StartedSetup>("POST", `${runner(runnerId)}/setups`, input),
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
  relate: (ticketId: string, input: RelationCreate) =>
    call<Relation>("POST", `/api/tickets/${encodeURIComponent(ticketId)}/relations`, input),
  removeRelation: (ticketId: string, relationId: string) =>
    call<void>("DELETE", `/api/tickets/${encodeURIComponent(ticketId)}/relations/${encodeURIComponent(relationId)}`),
  runs: (ticketId: string) => call<Run[]>("GET", `/api/tickets/${encodeURIComponent(ticketId)}/runs`),
  run: (id: string) => call<Run>("GET", `/api/runs/${encodeURIComponent(id)}`),
  transcriptHook: () => call<TranscriptHook>("GET", "/api/transcript-hook"),
  transcript: (id: string) => call<Transcript>("GET", `/api/transcripts/${encodeURIComponent(id)}`),
  agentTranscripts: (agentId: string) =>
    call<Transcript[]>("GET", `/api/agents/${encodeURIComponent(agentId)}/transcripts`),
  ticketTranscripts: (ticketId: string) =>
    call<TicketTranscript[]>("GET", `/api/tickets/${encodeURIComponent(ticketId)}/transcripts`),
  transcriptEntries: (id: string, after?: number) =>
    call<{ entries: TranscriptEntry[]; next: number | null }>(
      "GET",
      `/api/transcripts/${encodeURIComponent(id)}/entries${after === undefined ? "" : `?after=${after}`}`,
    ),
  deleteTranscript: (id: string) => call<void>("DELETE", `/api/transcripts/${encodeURIComponent(id)}`),
  redactTranscript: (id: string, text: string) =>
    call<Transcript>("POST", `/api/transcripts/${encodeURIComponent(id)}/redactions`, { text }),
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
  linkPullRequest: (ticketId: string, pullRequest: string) =>
    call<PullRequest>("POST", `/api/tickets/${encodeURIComponent(ticketId)}/pull-requests`, { pullRequest }),
  unlinkPullRequest: (ticketId: string, pullRequestId: number) =>
    call<void>("DELETE", `/api/tickets/${encodeURIComponent(ticketId)}/pull-requests/${pullRequestId}`),
  linkedDocuments: (ticketId: string) =>
    call<LinkedDocument[]>("GET", `/api/tickets/${encodeURIComponent(ticketId)}/documents`),
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
    call<DecisionVersion & { body: string }>("GET", `${decision(id)}/versions/${number}`),
  compareDecisionVersions: (id: string, from: number, to: number) =>
    call<Comparison>("GET", `${decision(id)}/versions/compare?from=${from}&to=${to}`),
  search: (workspaceId: string, query: { q: string; project?: string }) =>
    call<SearchResult[]>(
      "GET",
      `/api/workspaces/${encodeURIComponent(workspaceId)}/search?${new URLSearchParams({ ...query })}`,
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
