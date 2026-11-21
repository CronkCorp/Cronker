import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode, type Ref } from "react";
import {
  api,
  nameOf,
  priorities,
  type Agent,
  type Attachment,
  type Change,
  type Completion,
  type Comment,
  labelRuleShown,
  type LabelRule,
  type LinkedArtifact,
  type LinkedDocument,
  type PullRequest,
  type Member,
  type Priority,
  type Project,
  type RelationKind,
  type Report,
  type Run,
  type Ticket,
  type TicketEdit,
  type TicketRef,
  type TicketRelations,
  type TicketSummary,
  type TicketTranscript,
  type User,
  type Workspace,
} from "./api.js";
import { attachAll, Attachments, FileList } from "./attachments.js";
import { field, submitOnCtrlOrCmdEnter, useSubmit } from "./forms.js";
import { usePlace } from "./frame.js";
import { scrollToAndFocus, shortcutStandsAside } from "./keys.js";
import { useArrivals, useLatest, useLiveEvents } from "./live.js";
import { Markdown } from "./markdown.js";
import { priorityLabel } from "./projects.js";
import { PullRequestCards, PullRequestRows } from "./pull-requests.js";
import { Link } from "./router.js";
import { Actor, Avatar, type ActorRef } from "./ui/actor.js";
import { fitWindow } from "./ui/fit-window.js";
import { Actions, Button, CommentButton, daySeparator, ExternalLink, Field, FormError, LiveIndicator, PageHead, RelativeTime, workspaceCrumb } from "./ui/controls.js";
import { Chip, KindLabel, ModelLabel, PriorityTag, RunState, StatusPill } from "./ui/labels.js";
import { Dialog, DialogActions, DialogClose } from "./ui/overlays.js";
import { FieldPicker, Picker } from "./ui/picker.js";

/**
 * A Ticket: its title, description and Attachments, one timeline of its Comments, Reports, Runs and Changes, and
 * the Comment box; beside them its fields, its Run, its Relations, Linked Documents and Files.
 */
export function TicketScreen({
  workspace,
  user,
  ticketId,
  onOtherWorkspace,
}: {
  workspace: Workspace;
  /** The signed-in User, who delegates only to their own Agents. */
  user: User;
  ticketId: string;
  /** Offered a Ticket of another Workspace; returns whether the screen switches to that Workspace. */
  onOtherWorkspace?: (workspaceId: string) => boolean;
}) {
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [reportFiles, setReportFiles] = useState<Attachment[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [timeline, setTimeline] = useState<Change[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [transcripts, setTranscripts] = useState<TicketTranscript[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [relations, setRelations] = useState<TicketRelations | null>(null);
  const [documentLinks, setDocumentLinks] = useState<LinkedDocument[] | null>(null);
  const [artifactLinks, setArtifactLinks] = useState<LinkedArtifact[] | null>(null);
  const [pullRequests, setPullRequests] = useState<PullRequest[]>([]);
  const [projectTickets, setProjectTickets] = useState<TicketSummary[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [dropping, setDropping] = useState(false);
  // Whether the timeline's first load is in, after which new entries are marked as they arrive.
  const [loaded, setLoaded] = useState(false);
  const otherWorkspace = useRef(onOtherWorkspace);
  otherWorkspace.current = onOtherWorkspace;
  // The Comment box stays at the end of the timeline; the Comment button and C take the User there.
  const commentBox = useRef<HTMLTextAreaElement>(null);
  const toCommentBox = () => commentBox.current && scrollToAndFocus(commentBox.current);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "c" || shortcutStandsAside(event) || !commentBox.current) return;
      event.preventDefault();
      toCommentBox();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  usePlace("project", project?.id ?? null);

  const latestTicket = useLatest();
  const latestProject = useLatest();
  const latestComments = useLatest();
  const latestReports = useLatest();
  const latestAttachments = useLatest();
  const latestTimeline = useLatest();
  const latestRuns = useLatest();
  const latestTranscripts = useLatest();
  const latestRelations = useLatest();
  const latestLinkedDocuments = useLatest();
  const latestLinkedArtifacts = useLatest();
  const latestPullRequests = useLatest();
  const latestProjectTickets = useLatest();
  const latestReportFiles = useLatest();
  const fail = (e: Error) => setFailure(e.message);
  const loadTimeline = useCallback(() => {
    latestTimeline(api.timeline(ticketId), setTimeline);
    latestRuns(api.runs(ticketId), setRuns);
    latestTranscripts(api.ticketTranscripts(ticketId), setTranscripts);
  }, [ticketId, latestTimeline, latestRuns, latestTranscripts]);
  const loadAttachments = useCallback(
    () => latestAttachments(api.attachments({ kind: "ticket", id: ticketId }), setAttachments, fail),
    [ticketId, latestAttachments],
  );
  const loadComments = useCallback(
    () => latestComments(api.comments(ticketId), setComments, fail),
    [ticketId, latestComments],
  );
  const loadReports = useCallback(() => {
    const loaded = api.reports(ticketId);
    latestReports(loaded, setReports, fail);
    // A Report is a Document, so its files are the Document's.
    latestReportFiles(
      loaded.then((all) => Promise.all(all.map((r) => api.attachments({ kind: "document", id: r.id })))).then((lists) => lists.flat()),
      setReportFiles,
    );
  }, [ticketId, latestReports, latestReportFiles]);
  const loadPullRequests = useCallback(
    () => latestPullRequests(api.pullRequests(ticketId), setPullRequests, fail),
    [ticketId, latestPullRequests],
  );
  const loadLinks = useCallback(() => {
    latestRelations(api.relations(ticketId), setRelations, fail);
    latestLinkedDocuments(api.linkedDocuments(ticketId), setDocumentLinks, fail);
    latestLinkedArtifacts(api.linkedArtifacts(ticketId), setArtifactLinks, fail);
  }, [ticketId, latestRelations, latestLinkedDocuments, latestLinkedArtifacts]);

  useEffect(() => {
    const first = api.ticket(ticketId);
    // Shown only until a later fetch of the Ticket answers; the screen waits for its Project too.
    latestTicket(first, setTicket, fail);
    first.then(async (found) => {
      const ticketProject = await api.project(found.projectId);
      // A Ticket of another of the User's Workspaces isn't shown under this one's name.
      if (ticketProject.workspaceId !== workspace.id) {
        if (!otherWorkspace.current?.(ticketProject.workspaceId)) setFailure("No such Ticket.");
        return;
      }
      setProject(ticketProject);
      latestProjectTickets(api.tickets(ticketProject.id), setProjectTickets, fail);
    }, fail);
    api.members(workspace.id).then(setMembers, fail);
    api.agents(workspace.id).then(setAgents, fail);
    const comments = api.comments(ticketId);
    const changes = api.timeline(ticketId);
    const runs = api.runs(ticketId);
    const transcripts = api.ticketTranscripts(ticketId);
    latestComments(comments, setComments, fail);
    latestTimeline(changes, setTimeline, fail);
    latestRuns(runs, setRuns, fail);
    latestTranscripts(transcripts, setTranscripts, fail);
    void Promise.allSettled([comments, changes, runs, transcripts]).then(() => setLoaded(true));
    loadReports();
    loadAttachments();
    loadLinks();
    loadPullRequests();
  }, [ticketId, workspace.id, latestTicket, latestComments, loadReports, latestTimeline, latestRuns, latestTranscripts, latestProjectTickets, loadAttachments, loadLinks, loadPullRequests]);

  // What others change shows up as it happens; what this screen saves comes back the same way.
  useLiveEvents(workspace.id, (event) => {
    const all = event.type === "reconnected";
    const thisTicket = !all && "ticketId" in event && event.ticketId === ticketId;
    if (all || (thisTicket && event.type === "ticket.changed")) {
      latestTicket(api.ticket(ticketId), setTicket, fail);
      loadTimeline();
      loadLinks();
    }
    if (all || (thisTicket && event.type === "pull_requests.changed")) loadPullRequests();
    if (all || (thisTicket && event.type === "transcripts.changed")) latestTranscripts(api.ticketTranscripts(ticketId), setTranscripts);
    if (all || (thisTicket && event.type === "comment.added")) loadComments();
    if (all || (thisTicket && (event.type === "report.added" || event.type === "report.changed"))) loadReports();
    // A Comment's Attachments come with the Comments.
    if (all || (thisTicket && event.type === "attachments.changed")) {
      loadAttachments();
      loadComments();
      loadReports();
    }
    if (project && (all || (event.type === "statuses.changed" && event.projectId === project.id))) {
      latestProject(api.project(project.id), setProject, fail);
    }
    // The Project's Tickets are offered as parents and Relations; keys and titles may have changed.
    const projectTicket = (event.type === "ticket.created" || event.type === "ticket.changed") && event;
    if (project && (all || (projectTicket && projectTicket.projectId === project.id))) {
      latestProjectTickets(api.tickets(project.id), setProjectTickets, fail);
    }
  });

  /** Shows the Ticket a change returns, and what else it changed; or why it was refused. */
  const apply = async (saved: Promise<Ticket>) => {
    setError(null);
    try {
      latestTicket(saved, setTicket);
      await saved;
      loadTimeline();
      loadLinks();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const save = (edit: TicketEdit) => apply(api.editTicket(ticketId, edit));

  // The live refetch may have shown the new Comment already.
  const addComment = (comment: Comment) =>
    setComments((shown) => (shown.some((c) => c.id === comment.id) ? shown : [...shown, comment]));

  /** Dropping or pasting files anywhere on the page attaches them to the Ticket. */
  const attachToTicket = (files: File[]) => {
    if (files.length === 0) return;
    setError(null);
    attachAll({ kind: "ticket", id: ticketId }, files).then(loadAttachments, (e: Error) => {
      setError(e.message);
      loadAttachments();
    });
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    setDropping(false);
    if (event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    attachToTicket([...event.dataTransfer.files]);
  };
  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const files = [...event.clipboardData.files];
    if (files.length === 0) return;
    // A paste into a text field that carries text too pastes the text and attaches nothing.
    const inField = (event.target as HTMLElement).closest("input, textarea");
    if (inField && event.clipboardData.getData("text")) return;
    event.preventDefault();
    attachToTicket(files);
  };

  if (failure) return <FormError error={failure} />;
  if (!ticket || !project || !relations || !documentLinks || !artifactLinks) return <p className="muted">Loading…</p>;
  const status = project.statuses.find((s) => s.id === ticket.statusId);
  const others = projectTickets.filter((t) => t.id !== ticket.id);
  return (
    <div
      className={`page ticket-page${dropping ? " dropping" : ""}`}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropping(false);
      }}
      onDrop={onDrop}
      onPaste={onPaste}
    >
      <PageHead
        crumbs={[
          workspaceCrumb(workspace),
          { label: <span className="mono">{project.key}</span>, to: `/projects/${project.id}` },
          { label: <span className="mono">{ticket.key}</span> },
        ]}
        title={
          <>
            <span className="ticket-key title-key">{ticket.key}</span> {ticket.title}
          </>
        }
        large
        switcher={<LiveIndicator workspaceId={workspace.id} />}
        actions={
          <>
            <Button variant="secondary" aria-keyshortcuts="C" title="Comment (C)" onClick={toCommentBox}>
              Comment
            </Button>
            {!editing && (
              <Button variant="secondary" onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
          </>
        }
      />
      <FormError error={error} />
      <div className="page-split">
        <div className="page ticket-main">
          {editing ? (
            <TextFields ticket={ticket} onSave={save} onDone={() => setEditing(false)} />
          ) : (
            <section aria-label="Description" className="panel description">
              {ticket.description ? (
                <Markdown text={ticket.description} mentions={ticket.mentions} />
              ) : (
                <p className="muted">No description. Edit adds one; Markdown and Ticket keys such as {project.key}-1 work.</p>
              )}
            </section>
          )}
          {status?.kind === "review" && <PullRequestCards pullRequests={pullRequests} />}
          <Attachments
            owner={{ kind: "ticket", id: ticket.id }}
            attachments={attachments}
            label="Attachments"
            dropHint="Drop files or paste to attach, anywhere on the Ticket"
            onChanged={loadAttachments}
          />
          <Timeline
            loaded={loaded}
            ticket={ticket}
            project={project}
            user={user}
            changes={timeline}
            runs={runs}
            transcripts={transcripts}
            comments={comments}
            reports={reports}
            onAdded={addComment}
            onChanged={loadComments}
          />
          <div className="ticket-comment">
            <CommentForm
              label="New Comment"
              button="Comment"
              placeholder="Comment… Markdown, and Ticket keys link"
              boxRef={commentBox}
              onSend={async (body) => addComment(await api.comment(ticket.id, { body }))}
            />
            <p className="muted small keys-line">
              <kbd>C</kbd> writes a Comment from anywhere on the Ticket, as the Comment button does.
            </p>
          </div>
        </div>
        <aside className="side side-fits-window" aria-label="Details" ref={fitWindow}>
          <Fields ticket={ticket} project={project} members={members} agents={agents} user={user} labels={labelsOf(projectTickets, ticket)} onSave={save}>
            {ticket.verification && (
              <Verification
              ticket={ticket}
              runs={runs}
              onAccept={() => apply(api.acceptTicket(ticket.id))}
              onReopen={async (comment) => {
                const reopened = api.reopenTicket(ticket.id, comment);
                await apply(reopened);
                await reopened;
                loadComments();
              }}
              />
            )}
          </Fields>
          <RunCard ticket={ticket} runs={runs} agents={agents} step={status?.step ? { name: status.name, model: status.step.model } : null} onRetried={() => apply(api.retry(ticket.id))} />
          <PullRequestRows pullRequests={pullRequests} />
          <Relations
            ticket={ticket}
            relations={relations}
            suggestions={others}
            onParent={(parentId) => save({ parentId })}
            onChanged={() => {
              loadLinks();
              loadTimeline();
            }}
          />
          <Linked
            kind={linkedDocuments}
            ticket={ticket}
            workspaceId={workspace.id}
            linked={documentLinks}
            onChanged={() => {
              loadLinks();
              loadTimeline();
            }}
          />
          <Linked
            kind={linkedArtifacts}
            ticket={ticket}
            workspaceId={workspace.id}
            linked={artifactLinks}
            onChanged={() => {
              loadLinks();
              loadTimeline();
            }}
          />
          <FileList
            attachments={[...attachments, ...comments.flatMap((c) => c.attachments), ...reportFiles]}
            onChanged={() => {
              loadAttachments();
              loadComments();
            }}
          />
        </aside>
      </div>
    </div>
  );
}

/** Every Label used on the Project's Tickets, offered when picking Labels. */
function labelsOf(tickets: TicketSummary[], ticket: Ticket): string[] {
  return [...new Set([...ticket.labels, ...tickets.flatMap((t) => t.labels)])].sort((a, b) => a.localeCompare(b));
}

function TextFields({ ticket, onSave, onDone }: { ticket: Ticket; onSave: (edit: TicketEdit) => Promise<void>; onDone: () => void }) {
  const [title, setTitle] = useState(ticket.title);
  const [description, setDescription] = useState(ticket.description);
  // A change saved elsewhere replaces what is shown, unless it is being edited here.
  const saved = useRef({ title: ticket.title, description: ticket.description });
  useEffect(() => {
    const before = saved.current;
    setTitle((shown) => (shown === before.title ? ticket.title : shown));
    setDescription((shown) => (shown === before.description ? ticket.description : shown));
    saved.current = { title: ticket.title, description: ticket.description };
  }, [ticket.title, ticket.description]);
  const { busy, onSubmit } = useSubmit(async () => {
    await onSave({ title, description });
    onDone();
  });
  return (
    <form onSubmit={onSubmit} className="panel">
      <Field label="Title">
        <input value={title} required maxLength={300} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Description" hint="Markdown. Ticket keys link to their Tickets.">
        <textarea className="markdown-source" value={description} rows={8} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Actions>
        <Button type="submit" variant="primary" disabled={busy || (title === ticket.title && description === ticket.description)}>
          Save
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </Actions>
    </form>
  );
}

/** One field saved on its own when submitted or left. */
function FieldForm({ label, id, children, onSave }: { label: string; id: string; children: ReactNode; onSave: (form: FormData) => Promise<void> }) {
  const { onSubmit } = useSubmit(onSave);
  return (
    <form
      className="field-row"
      onSubmit={onSubmit}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.requestSubmit();
      }}
    >
      <label className="field-row-label" htmlFor={id}>
        {label}
      </label>
      {children}
    </form>
  );
}

const none = <span className="muted">None</span>;

/** Autonomous Delegation as picked; a Ticket not yet delegated has neither and takes the Project's. */
const autonomy = [
  { value: "on", on: true, shown: "On", hint: "a Step may complete it" },
  { value: "off", on: false, shown: "Off", hint: "each Step stops for a User" },
];

/** The Ticket's fields, each edited in place with a picker. */
function Fields({
  ticket,
  project,
  members,
  agents,
  user,
  labels,
  onSave,
  children,
}: {
  ticket: Ticket;
  project: Project;
  members: Member[];
  agents: Agent[];
  user: User;
  /** The Labels to offer. */
  labels: string[];
  onSave: (edit: TicketEdit) => Promise<void>;
  /** Rows shown after Labels, such as Verification. */
  children?: ReactNode;
}) {
  const status = project.statuses.find((s) => s.id === ticket.statusId);
  const assignee = members.find((m) => m.user.id === ticket.assigneeId)?.user;
  const own = agents.filter((a) => a.owner.id === user.id);
  const delegate = agents.find((a) => a.id === ticket.delegateId);
  // Labels picked in a row build on each other before the Ticket comes back.
  const [shownLabels, setShownLabels] = useState(ticket.labels);
  const savedLabels = ticket.labels.join("\n");
  useEffect(() => setShownLabels(savedLabels ? savedLabels.split("\n") : []), [savedLabels]);
  const saveLabels = (next: string[]) => {
    setShownLabels(next);
    void onSave({ labels: next });
  };
  const offeredAgents = delegate && !own.some((a) => a.id === delegate.id) ? [...own, delegate] : own;
  return (
    <section aria-label="Fields" className="panel side-section fields">
      <FieldPicker
        label="Status"
        value={status ? <StatusPill kind={status.kind} name={status.name} model={status.step?.model} /> : none}
        options={project.statuses.map((s) => ({ value: s.id, label: s.name, content: <StatusPill kind={s.kind} name={s.name} model={s.step?.model} /> }))}
        selected={[ticket.statusId]}
        // An Unverified Ticket leaves its Done Status only by Accept or Reopen.
        disabled={ticket.verification === "unverified"}
        title={ticket.verification === "unverified" ? "Accept or Reopen it to move it" : undefined}
        onPick={(statusId) => statusId !== ticket.statusId && void onSave({ statusId })}
      />
      <FieldPicker
        label="Priority"
        value={ticket.priority === "none" ? none : <PriorityTag priority={ticket.priority} />}
        options={priorities.map(({ priority, label }) => ({
          value: priority,
          label,
          content: priority === "none" ? <span className="muted">None</span> : <PriorityTag priority={priority} />,
        }))}
        selected={[ticket.priority]}
        onPick={(priority) => priority !== ticket.priority && void onSave({ priority: priority as Priority })}
      />
      <FieldPicker
        label="Assignee"
        value={assignee ? <Actor actor={{ kind: "user", name: nameOf(assignee) }} /> : <span className="muted">Nobody</span>}
        options={[
          { value: "", label: "Nobody", content: <span className="muted">Nobody</span> },
          ...members.map(({ user: member }) => ({
            value: member.id,
            label: nameOf(member),
            content: <Actor actor={{ kind: "user", name: nameOf(member) }} />,
          })),
        ]}
        selected={[ticket.assigneeId ?? ""]}
        onPick={(id) => (id || null) !== ticket.assigneeId && void onSave({ assigneeId: id || null })}
      />
      <FieldPicker
        label="Delegate"
        value={
          delegate ? (
            <Actor actor={{ kind: "agent", name: delegate.name, owner: delegate.owner.id === user.id ? null : nameOf(delegate.owner) }} />
          ) : (
            <span className="muted">Nobody</span>
          )
        }
        options={[
          { value: "", label: "Nobody", content: <span className="muted">Nobody: take it back</span> },
          ...offeredAgents.map((agent) => ({
            value: agent.id,
            label: agent.name,
            content: <Actor actor={{ kind: "agent", name: agent.name, owner: agent.owner.id === user.id ? null : nameOf(agent.owner) }} />,
          })),
        ]}
        selected={[ticket.delegateId ?? ""]}
        onPick={(id) => (id || null) !== ticket.delegateId && void onSave({ delegateId: id || null })}
      />
      {ticket.delegateId === null && own.length === 0 && (
        <p className="field-note">You have no Agent in this Workspace to delegate to.</p>
      )}
      <FieldPicker
        label="Autonomous Delegation"
        value={autonomy.find((a) => a.on === ticket.autonomousDelegation)?.shown ?? <span className="muted">The Project's, once delegated</span>}
        options={autonomy.map(({ value, shown, hint }) => ({
          value,
          label: shown,
          content: (
            <span>
              {shown} <span className="muted small">· {hint}</span>
            </span>
          ),
        }))}
        selected={autonomy.filter((a) => a.on === ticket.autonomousDelegation).map((a) => a.value)}
        onPick={(picked) => {
          const on = autonomy.find((a) => a.value === picked)!.on;
          if (on !== ticket.autonomousDelegation) void onSave({ autonomousDelegation: on });
        }}
      />
      <FieldPicker
        label="Labels"
        value={shownLabels.length ? shownLabels.map((label) => <Chip key={label}>{label}</Chip>) : none}
        options={labels.map((label) => ({ value: label, label }))}
        selected={shownLabels}
        multiple
        onPick={(label) => saveLabels(shownLabels.includes(label) ? shownLabels.filter((l) => l !== label) : [...shownLabels, label])}
        onCreate={(label) => !shownLabels.includes(label) && saveLabels([...shownLabels, label])}
      />
      {children}
      <FieldForm
        key={`due:${ticket.dueDate}`}
        label="Due date"
        id="ticket-due-date"
        onSave={async (form) => {
          const next = field(form, "dueDate") || null;
          if (next !== ticket.dueDate) await onSave({ dueDate: next });
        }}
      >
        <input id="ticket-due-date" name="dueDate" type="date" defaultValue={ticket.dueDate ?? ""} className="field-inline" />
      </FieldForm>
      <FieldForm
        key={`estimate:${ticket.estimate}`}
        label="Estimate"
        id="ticket-estimate"
        onSave={async (form) => {
          const text = field(form, "estimate");
          const next = text === "" ? null : Number(text);
          if (next !== ticket.estimate) await onSave({ estimate: next });
        }}
      >
        <input id="ticket-estimate" name="estimate" type="number" min={0} step="any" defaultValue={ticket.estimate ?? ""} className="field-inline" />
      </FieldForm>
    </section>
  );
}

/**
 * A Ticket a Run or a merge completed: Unverified until the User Accepts it, or Reopens it with a Comment saying why,
 * which does what the Ticket's completion says: back to a Step's Status, or, when no Step produced the work, nowhere.
 */
function Verification({
  ticket,
  runs,
  onAccept,
  onReopen,
}: {
  ticket: Ticket;
  runs: Run[];
  onAccept: () => Promise<void>;
  onReopen: (comment: string) => Promise<void>;
}) {
  const [reopening, setReopening] = useState(false);
  const [completion, setCompletion] = useState<Completion | null>(null);
  useEffect(() => {
    let current = true;
    void api.completion(ticket.id).then(
      (loaded) => current && setCompletion(loaded),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [ticket]);
  const { error, busy, onSubmit } = useSubmit(async (form) => {
    await onReopen(field(form, "comment"));
    setReopening(false);
  });
  const merge = completion?.merge ?? null;
  const completing = runs.filter((r) => r.state === "finished").at(-1);
  const by = merge
    ? completing?.outcome === "merged"
      ? `${completing.agent.name}'s Run of the ${completing.step.name} Step merged ${pullRequestName(merge.pullRequest)}`
      : merge.mergedBy
        ? `@${merge.mergedBy} merged ${pullRequestName(merge.pullRequest)}`
        : `${pullRequestName(merge.pullRequest)} was merged`
    : completing
      ? `${completing.agent.name}'s Run of the ${completing.step.name} Step`
      : "A Run";
  const reopen = completion?.reopen;
  const back = !reopen
    ? "send it back"
    : reopen.kind === "back"
      ? `send it back to the ${reopen.status.name} Step`
      : reopen.kind === "stays"
        ? "leave it here for you to move"
        : "send it back to a Step whose Status has since been removed, which Cronk refuses";
  return (
    <section aria-label="Verification" className="verification">
      <div className="field-row">
        <span className="field-row-label">Verification</span>
        {ticket.verification === "verified" ? <Chip tone="ok">Verified</Chip> : <Chip tone="info">Unverified</Chip>}
      </div>
      {ticket.verification === "verified" ? (
        <p className="muted small">{merge ? `${by}, completing this; it is Verified.` : "A Run completed this and a User Accepted it."}</p>
      ) : (
        <>
          <p className="small">
            {by}
            {merge ? ", completing this" : " completed this"}. It is Unverified until you Accept it, or Reopen it to {back}.
          </p>
          <Actions>
            <Button variant="primary" size="small" onClick={() => void onAccept()}>
              Accept
            </Button>
            <Button size="small" onClick={() => setReopening(true)}>
              Reopen…
            </Button>
          </Actions>
        </>
      )}
      <Dialog open={reopening} onOpenChange={setReopening} title={`Reopen ${ticket.key}`} description={`With your Comment, Reopen will ${back}.`}>
        <form onSubmit={onSubmit}>
          <Field label="Why reopen it?">
            <textarea name="comment" required rows={4} autoFocus />
          </Field>
          <FormError error={error} />
          <DialogActions>
            <DialogClose asChild>
              <Button>Cancel</Button>
            </DialogClose>
            <Button type="submit" variant="primary" disabled={busy}>
              Reopen
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </section>
  );
}

/** A Pull Request as the timeline and Verification name it: its Repository and number. */
const pullRequestName = (pr: { repository: string; number: number }) => `${pr.repository}#${pr.number}`;

const waitingReasons = {
  runnerSlot: "Runner full",
  runnerPaused: "Runner rate-limited",
  blocked: "Blocked by another Ticket",
} as const;

/** The Ticket's Run while one is running or waiting, or gone wrong with Retry; hidden otherwise. */
function RunCard({
  ticket,
  runs,
  agents,
  step,
  onRetried,
}: {
  ticket: Ticket;
  runs: Run[];
  agents: Agent[];
  /** The Step it waits for, named after its Status. */
  step: { name: string; model: string } | null;
  onRetried: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const latest = runs.at(-1);
  const wentWrong = latest && (latest.state === "failed" || latest.state === "lost" || latest.state === "refused") && ticket.lastRun?.id === latest.id;
  if (ticket.waiting) {
    const delegate = agents.find((a) => a.id === ticket.delegateId);
    return (
      <section aria-label="Run" className="panel side-section run-card">
        <div className="run-card-head">
          <RunState state="waiting" reason={waitingReasons[ticket.waiting]} />
        </div>
        {delegate && <Actor actor={{ kind: "agent", name: delegate.name }} />}
        {step && (
          <p className="small">
            {step.name} <ModelLabel model={step.model} />
          </p>
        )}
        <p className="small muted">Waiting: {waitingReasons[ticket.waiting]}.</p>
      </section>
    );
  }
  if (!latest || (latest.state !== "running" && !wentWrong)) return null;
  return (
    <section aria-label="Run" className={`panel side-section run-card${wentWrong ? " run-card-wrong" : ""}`}>
      <div className="run-card-head">
        <RunState state={latest.state} />
        <span className="run-card-started">
          since <RelativeTime at={latest.startedAt} />
        </span>
      </div>
      <Actor actor={{ kind: "agent", name: latest.agent.name }} />
      <p className="small">
        {latest.step.name} <ModelLabel model={latest.model} />
      </p>
      {latest.endReason && <p className="small">{latest.endReason}</p>}
      <Actions>
        {wentWrong && (
          <Button
            variant="primary"
            size="small"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              onRetried().finally(() => setBusy(false));
            }}
          >
            Retry
          </Button>
        )}
        {latest.sessionUrl && (
          <a href={latest.sessionUrl} target="_blank" rel="noreferrer" className="small">
            Session
          </a>
        )}
      </Actions>
    </section>
  );
}

const relationGroups: { kind: RelationKind; label: string }[] = [
  { kind: "blockedBy", label: "Blocked by" },
  { kind: "blocks", label: "Blocks" },
  { kind: "relatesTo", label: "Relates to" },
];

const relationLabel = (kind: RelationKind) => relationGroups.find((g) => g.kind === kind)!.label;

function TicketLink({ ticket }: { ticket: TicketRef }) {
  return (
    <Link to={`/tickets/${ticket.id}`} className="ticket-link">
      <span className="ticket-key">{ticket.key}</span> {ticket.title}
    </Link>
  );
}

/** The Ticket's parent, Sub-Tickets, blockers, what it blocks and what it relates to, with a form to add a Relation. */
function Relations({
  ticket,
  relations,
  suggestions,
  onParent,
  onChanged,
}: {
  ticket: Ticket;
  relations: TicketRelations;
  /** Tickets to offer as the parent, and while typing a key; any Ticket of the Workspace may be named. */
  suggestions: TicketSummary[];
  onParent: (parentId: string | null) => Promise<void>;
  onChanged: () => void;
}) {
  const [removeError, setRemoveError] = useState<string | null>(null);
  // Kept after adding, for adding several of one kind in a row.
  const [kind, setKind] = useState<RelationKind>("blockedBy");
  const { error, busy, onSubmit } = useSubmit(async (form, element) => {
    const ticketKey = field(form, "ticket").trim();
    await api.relate(ticket.id, { kind, ticketKey });
    (element.elements.namedItem("ticket") as HTMLInputElement).value = "";
    onChanged();
  });
  const remove = async (relationId: string) => {
    setRemoveError(null);
    try {
      await api.removeRelation(ticket.id, relationId);
      onChanged();
    } catch (e) {
      setRemoveError(e instanceof Error ? e.message : String(e));
    }
  };
  const { parent, subTickets } = relations;
  return (
    <section aria-label="Relations" className="panel side-section">
      <h2 className="side-title">Relations</h2>
      <FieldPicker
        label="Parent"
        before={parent && <TicketLink ticket={parent} />}
        value={parent ? <span className="muted small">Change</span> : none}
        options={[
          { value: "", label: "None", content: <span className="muted">None</span> },
          ...suggestions.map((t) => ({
            value: t.id,
            label: `${t.key} ${t.title}`,
            content: (
              <span>
                <span className="ticket-key">{t.key}</span> {t.title}
              </span>
            ),
          })),
        ]}
        selected={[ticket.parentId ?? ""]}
        onPick={(id) => (id || null) !== ticket.parentId && void onParent(id || null)}
      />
      {subTickets.length > 0 && (
        <div className="side-group">
          <h3 id="sub-tickets" className="side-group-title">
            Sub-Tickets
          </h3>
          <ul aria-labelledby="sub-tickets" className="side-list">
            {subTickets.map((sub) => (
              <li key={sub.id}>
                <TicketLink ticket={sub} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {relationGroups.map(({ kind, label }) => {
        const inGroup = relations.relations.filter((r) => r.kind === kind);
        if (inGroup.length === 0) return null;
        return (
          <div key={kind} className="side-group">
            <h3 id={`relations-${kind}`} className="side-group-title">
              {label}
            </h3>
            <ul aria-labelledby={`relations-${kind}`} className="side-list">
              {inGroup.map((relation) => (
                <li key={relation.id}>
                  <TicketLink ticket={relation.ticket} />{" "}
                  <Button variant="ghost" size="small" onClick={() => void remove(relation.id)}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      <FormError error={removeError} />
      <form onSubmit={onSubmit} className="side-form">
        <div className="side-form-row">
          <Picker
            label="Relation"
            options={relationGroups.map(({ kind, label }) => ({ value: kind, label }))}
            selected={[kind]}
            onPick={(picked) => setKind(picked as RelationKind)}
            trigger={
              <Button size="small" aria-haspopup="listbox" aria-label={`Relation ${relationLabel(kind)}`}>
                {relationLabel(kind)} <span aria-hidden="true">▾</span>
              </Button>
            }
          />
          <input name="ticket" required list="relation-tickets" placeholder={`Key, such as ${ticket.key}`} aria-label="Ticket" className="mono" />
        </div>
        <datalist id="relation-tickets">
          {suggestions.map((t) => (
            <option key={t.id} value={t.key}>
              {t.title}
            </option>
          ))}
        </datalist>
        <div>
          <Button type="submit" size="small" disabled={busy}>
            Add
          </Button>
        </div>
      </form>
      <FormError error={error} />
    </section>
  );
}

/** What the Ticket links of one kind, Documents or Artifacts: how they are named, read, linked and unlinked. */
interface Linkable {
  /** The kind's name, such as "Document". */
  noun: string;
  /** What linking one is called, such as "Link a Document". */
  linkLabel: string;
  /** Where one is shown. */
  page: (id: string) => string;
  /** Those of the Ticket's Project and of the Workspace that could be linked. */
  offered: (projectId: string, workspaceId: string) => Promise<{ project: { id: string; title: string }[]; workspace: { id: string; title: string }[] }>;
  link: (ticketId: string, id: string) => Promise<unknown>;
  unlink: (ticketId: string, id: string) => Promise<unknown>;
}

const linkedDocuments: Linkable = {
  noun: "Document",
  linkLabel: "Link a Document",
  page: (id) => `/documents/${id}`,
  offered: async (projectId, workspaceId) => {
    const [project, workspace] = await Promise.all([
      api.documents({ kind: "project", id: projectId }),
      api.documents({ kind: "workspace", id: workspaceId }),
    ]);
    return { project, workspace };
  },
  link: api.linkDocument,
  unlink: api.unlinkDocument,
};

const linkedArtifacts: Linkable = {
  noun: "Artifact",
  linkLabel: "Link an Artifact",
  page: (id) => `/artifacts/${id}`,
  offered: async (projectId, workspaceId) => {
    const [project, workspace] = await Promise.all([
      api.artifacts({ kind: "project", id: projectId }),
      api.artifacts({ kind: "workspace", id: workspaceId }),
    ]);
    return { project, workspace };
  },
  link: api.linkArtifact,
  unlink: api.unlinkArtifact,
};

/**
 * The Documents or Artifacts linked to the Ticket, each a link to it, with a picker to link another of the Ticket's
 * Project or of the Workspace.
 */
function Linked({
  kind,
  ticket,
  workspaceId,
  linked,
  onChanged,
}: {
  kind: Linkable;
  ticket: Ticket;
  workspaceId: string;
  linked: { id: string; projectId: string | null; title: string }[];
  onChanged: () => void;
}) {
  const [choices, setChoices] = useState<Awaited<ReturnType<Linkable["offered"]>> | null>(null);
  const [choicesError, setChoicesError] = useState<string | null>(null);
  // What may be linked isn't live, so it is read again on opening the list and after each link.
  const loadChoices = useCallback(() => {
    kind.offered(ticket.projectId, workspaceId).then(
      (found) => {
        setChoicesError(null);
        setChoices(found);
      },
      (e: Error) => setChoicesError(e.message),
    );
  }, [kind, ticket.projectId, workspaceId]);
  useEffect(loadChoices, [loadChoices]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Links or unlinks one at a time, showing why it was refused. */
  const change = async (save: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await save();
      loadChoices();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const isLinked = new Set(linked.map((d) => d.id));
  const unlinked = (all: { id: string; title: string }[]) => all.filter((d) => !isLinked.has(d.id));
  const offered = choices && { project: unlinked(choices.project), workspace: unlinked(choices.workspace) };
  const title = `Linked ${kind.noun}s`;
  return (
    <section aria-label={title} className="panel side-section">
      <h2 className="side-title">{title}</h2>
      {linked.length > 0 && (
        <ul aria-label={title} className="side-list">
          {linked.map((item) => (
            <li key={item.id}>
              <Link to={kind.page(item.id)}>{item.title}</Link>
              {item.projectId === null && <span className="muted small"> Workspace</span>}{" "}
              <Button variant="ghost" size="small" disabled={busy} onClick={() => void change(() => kind.unlink(ticket.id, item.id))}>
                Unlink
              </Button>
            </li>
          ))}
        </ul>
      )}
      <FormError error={choicesError} />
      <div>
        <Picker
          label={kind.linkLabel}
          onOpenChange={(open) => open && loadChoices()}
          options={
            offered
              ? [
                  ...offered.project.map((d) => ({ value: d.id, label: d.title, group: "This Project" })),
                  ...offered.workspace.map((d) => ({ value: d.id, label: d.title, group: "The Workspace" })),
                ]
              : []
          }
          onPick={(id) => void change(() => kind.link(ticket.id, id))}
          trigger={
            <Button size="small" aria-haspopup="listbox" disabled={busy}>
              {kind.linkLabel}…
            </Button>
          }
        />
      </div>
      <FormError error={error} />
    </section>
  );
}

function CommentForm({
  label,
  button,
  placeholder,
  hint,
  primary = true,
  boxRef,
  onSend,
}: {
  label: string;
  button: string;
  placeholder?: string;
  hint?: ReactNode;
  primary?: boolean;
  boxRef?: Ref<HTMLTextAreaElement>;
  onSend: (body: string) => Promise<void>;
}) {
  // The box empties once the Comment is placed; a refused one stays to be fixed.
  const { error, busy, onSubmit } = useSubmit(async (form, element) => {
    await onSend(field(form, "body"));
    element.reset();
  });
  return (
    <form className="comment-form" onSubmit={onSubmit}>
      <label className="field">
        <span className="sr-only">{label}</span>
        <textarea ref={boxRef} name="body" required rows={3} placeholder={placeholder ?? label} className="markdown-source" onKeyDown={submitOnCtrlOrCmdEnter} />
      </label>
      <FormError error={error} />
      <Actions>
        <CommentButton variant={primary ? "primary" : "secondary"} disabled={busy}>
          {button}
        </CommentButton>
        {hint && <span className="muted small">{hint}</span>}
      </Actions>
    </form>
  );
}

const fieldNames: Record<
  Exclude<
    Change["field"],
    "created" | "subTicket" | "stepSkipped" | "dismissed" | "linkedDocument" | "linkedArtifact" | "merged" | "sentBack" | "transcriptDeleted" | RelationKind
  >,
  string
> = {
  delegate: "Delegate",
  title: "Title",
  description: "Description",
  status: "Status",
  priority: "Priority",
  labels: "Labels",
  assignee: "Assignee",
  dueDate: "Due date",
  estimate: "Estimate",
  parent: "Parent",
  autonomousDelegation: "Autonomous Delegation",
  verification: "Verification",
};

const ticketShown = (ref: TicketRef) => `${ref.key} ${ref.title}`;

/** How the timeline tells of a Sub-Ticket or Relation added (`to` set) or removed (`from` set). */
const relationChanges: Record<"subTicket" | RelationKind, { added: string; removed: string }> = {
  subTicket: { added: "added Sub-Ticket", removed: "removed Sub-Ticket" },
  blocks: { added: "marked this as blocking", removed: "removed that this blocks" },
  blockedBy: { added: "marked this blocked by", removed: "removed the blocker" },
  relatesTo: { added: "related this to", removed: "removed the relation to" },
};

/**
 * What a `stepSkipped` Change records: the Status whose Step was skipped, its Label rule and the default Outcome; a
 * Merge Step that skipped itself records no Label rule but why it did.
 */
interface StepSkipped {
  status: { id: string; name: string };
  labelRule: LabelRule | null;
  mergeRule?: "agentsMayMergeOff" | "noAutonomousDelegation";
  outcome: string;
}

const mergeRulesShown = {
  agentsMayMergeOff: "agents may not merge in this Project",
  noAutonomousDelegation: "no Autonomous Delegation",
};

/** What a `merged` Change records: the Pull Request as it was then, and the login of the GitHub account that merged it. */
interface Merged {
  pullRequest: { repository: string; number: number; title: string };
  mergedBy: string | null;
}

/**
 * What a `sentBack` Change records: the Pull Request, and the failing check, the review requesting changes or the
 * conflict with its base branch on it, with the merge that caused it.
 */
interface SentBack {
  pullRequest: { repository: string; number: number; url: string };
  failure:
    | { kind: "check"; name: string; url: string | null }
    | { kind: "review"; reviewer: string | null; url: string | null }
    | { kind: "conflict"; branch: string; merge: { repository: string; number: number; url: string } | null };
}

/**
 * What a `transcriptDeleted` Change records: the Run whose Transcript a User deleted and its Step's name (both null
 * for a session outside a Run that named the Ticket), its session and its Agent.
 */
interface TranscriptDeleted {
  runId: string | null;
  step: string | null;
  sessionId: string;
  agent: { id: string; name: string };
}

function described(change: Change): string {
  if (change.field === "created") return "created the Ticket";
  if (change.field === "merged") {
    const { pullRequest, mergedBy } = change.to as Merged;
    const name = `${pullRequestName(pullRequest)} ${pullRequest.title}`;
    // An Agent's merge through Cronk is the Agent's own Change, in its Run.
    if (change.actor.kind === "agent") return `merged ${name}, completing it`;
    return mergedBy ? `completed it: @${mergedBy} merged ${name}` : `completed it: ${name} was merged`;
  }
  if (change.field === "sentBack") {
    const { pullRequest, failure } = change.to as SentBack;
    const name = pullRequestName(pullRequest);
    if (failure.kind === "conflict") {
      return failure.merge
        ? `sent it back: ${pullRequestName(failure.merge)} merged into ${failure.branch}, and ${name} conflicts with it`
        : `sent it back: ${name} conflicts with ${failure.branch}`;
    }
    return failure.kind === "check"
      ? `sent it back: the check ${failure.name} failed on ${name}`
      : `sent it back: ${failure.reviewer ? `@${failure.reviewer}` : "a reviewer"} requested changes on ${name}`;
  }
  if (change.field === "dismissed") return "dismissed it from the Inbox";
  if (change.field === "transcriptDeleted") {
    const { step, agent } = change.from as TranscriptDeleted;
    return step ? `deleted the Transcript of the ${step} Run` : `deleted a Transcript of ${agent.name}'s session outside a Run`;
  }
  if (change.field === "stepSkipped") {
    const { status, labelRule, mergeRule, outcome } = change.to as StepSkipped;
    // A Step skipped by its Label rule records the rule; a Merge Step that skipped itself records why instead.
    const why = mergeRule ? mergeRulesShown[mergeRule] : labelRuleShown(labelRule!);
    return `skipped the ${status.name} Step (${why}), moving on by ${outcome}`;
  }
  if (change.field === "description") return "changed the Description";
  if (change.field === "linkedDocument" || change.field === "linkedArtifact") {
    const noun = change.field === "linkedDocument" ? "Document" : "Artifact";
    return change.to
      ? `linked the ${noun} ${(change.to as { title: string }).title}`
      : `unlinked the ${noun} ${(change.from as { title: string }).title}`;
  }
  if (change.field in relationChanges) {
    const { added, removed } = relationChanges[change.field as keyof typeof relationChanges];
    return change.to
      ? `${added} ${ticketShown(change.to as TicketRef)}`
      : `${removed} ${ticketShown(change.from as TicketRef)}`;
  }
  const field = change.field as keyof typeof fieldNames;
  return `changed ${fieldNames[field]} from ${shown(change, change.from)} to ${shown(change, change.to)}`;
}

/**
 * Cronk's Changes recorded at the same moment as one that says why: a skipped Step's move on out of its Status,
 * a send-back's move, and a merge's move to a Done Status with the Verification it completed the Ticket as. An
 * Agent's merge through Cronk is recorded as that Agent's, in its Run, with its move and Verification.
 */
function recordedWith(change: Change, changes: Change[], project: Project): Change[] {
  if (!saysWhy(change)) return [];
  const { actor } = change;
  const sameActor = (c: Change) =>
    actor.kind === "cronk" ? c.actor.kind === "cronk" : c.actor.kind === actor.kind && c.actor.id === actor.id && c.runId === change.runId;
  const sameMoment = changes.filter((c) => sameActor(c) && c.at === change.at);
  if (change.field === "stepSkipped") {
    const skipped = (change.to as StepSkipped).status.id;
    const moved = sameMoment.find((c) => c.field === "status" && (c.from as { id: string }).id === skipped);
    return moved ? [moved] : [];
  }
  if (change.field === "sentBack") {
    // Cronk records the move right after it.
    const next = changes[changes.indexOf(change) + 1];
    return next && next.actor.kind === "cronk" && next.field === "status" && next.at === change.at ? [next] : [];
  }
  if (change.field !== "merged") return [];
  const kindOf = (value: unknown) => project.statuses.find((s) => s.id === (value as { id: string }).id)?.kind;
  return [
    sameMoment.find((c) => c.field === "status" && kindOf(c.to) === "done"),
    sameMoment.find((c) => c.field === "verification"),
  ].filter((c) => c !== undefined);
}

/** Whether the Change says why, folding in the Changes recorded with it: any of Cronk's, and an Agent's merge. */
const saysWhy = (change: Change) => change.actor.kind === "cronk" || change.field === "merged";

/** Each Change that says why with the Changes recorded with it, which show in its line instead of their own. */
function explanations(changes: Change[], project: Project): Map<string, Change[]> {
  return new Map(
    changes
      .map((change) => [change.id, recordedWith(change, changes, project)] as const)
      .filter(([, related]) => related.length > 0),
  );
}

/**
 * A Change Cronk made, or an Agent's merge, naming why: a merge names who merged what and how it completed the Ticket, a skipped Step
 * where it moved on to, and a send-back the failing check or requested changes that sent the Ticket back, and where.
 */
function describedWithReason(change: Change, related: Change[]): ReactNode {
  const moved = related.find((c) => c.field === "status");
  if (change.field === "merged") {
    const verification = related.find((c) => c.field === "verification")?.to;
    return (
      <>
        {described(change)}
        {moved && <>, moving it to {shown(moved, moved.to)}</>}
        {verification === "verified" ? ", Verified by that merge" : verification === "unverified" ? " as Unverified" : ""}
      </>
    );
  }
  if (change.field === "stepSkipped") {
    return (
      <>
        {described(change)}
        {moved && <> to {shown(moved, moved.to)}</>}
      </>
    );
  }
  if (change.field !== "sentBack") return described(change);
  const { pullRequest, failure } = change.to as SentBack;
  const pullRequestLink = <ExternalLink url={pullRequest.url}>{pullRequestName(pullRequest)}</ExternalLink>;
  if (failure.kind === "conflict") {
    return (
      <>
        sent it back{moved && <> from {shown(moved, moved.from)} to {shown(moved, moved.to)}</>}:{" "}
        {failure.merge ? (
          <>
            <ExternalLink url={failure.merge.url}>{pullRequestName(failure.merge)}</ExternalLink> merged into {failure.branch}, and{" "}
            {pullRequestLink} conflicts with it
          </>
        ) : (
          <>
            {pullRequestLink} conflicts with {failure.branch}
          </>
        )}
      </>
    );
  }
  return (
    <>
      sent it back{moved && <> from {shown(moved, moved.from)} to {shown(moved, moved.to)}</>}:{" "}
      {failure.kind === "check" ? (
        <>
          the check <ExternalLink url={failure.url}>{failure.name}</ExternalLink> failed on{" "}
        </>
      ) : (
        <>
          {failure.reviewer ? `@${failure.reviewer}` : "a reviewer"} <ExternalLink url={failure.url}>requested changes</ExternalLink> on{" "}
        </>
      )}
      <ExternalLink url={pullRequest.url}>{pullRequestName(pullRequest)}</ExternalLink>
    </>
  );
}

function shown(change: Change, value: unknown): string {
  if (value === null || (Array.isArray(value) && value.length === 0)) return "none";
  if (change.field === "priority") return priorityLabel(value as Priority);
  if (change.field === "status" || change.field === "assignee" || change.field === "delegate") {
    return (value as { name: string }).name;
  }
  if (change.field === "parent") return ticketShown(value as TicketRef);
  if (change.field === "autonomousDelegation") return value ? "on" : "off";
  if (change.field === "verification") return value === "verified" ? "Verified" : "Unverified";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

type Entry =
  | { at: string; key: string; kind: "change"; change: Change }
  | { at: string; key: string; kind: "run"; run: Run }
  | { at: string; key: string; kind: "comment"; comment: Comment }
  | { at: string; key: string; kind: "report"; report: Report }
  | { at: string; key: string; kind: "transcript"; transcript: TicketTranscript };

/**
 * Entries recorded at the same moment read cause before effect: the Transcript of the call that made a change,
 * then the move, then the Comment Cronk wrote about it, then a Report, then the Run the move started.
 */
const tieOrder: Record<Entry["kind"], number> = { transcript: 0, change: 1, comment: 2, report: 3, run: 4 };

/** Whether the page is scrolled to its end, where new entries may scroll it on. */
const atEnd = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 48;

/**
 * The Ticket's one chronology: its Comments (with their replies), Reports, Runs, Changes and the Transcripts of
 * sessions outside a Run that named it, oldest first.
 */
function Timeline({
  loaded,
  ticket,
  project,
  user,
  changes,
  runs,
  transcripts,
  comments,
  reports,
  onAdded,
  onChanged,
}: {
  /** Whether the first load is in; only what comes after it is marked as new. */
  loaded: boolean;
  ticket: Ticket;
  project: Project;
  user: User;
  changes: Change[];
  runs: Run[];
  /** The Transcripts of sessions outside a Run whose Cronk tool calls named the Ticket. */
  transcripts: TicketTranscript[];
  comments: Comment[];
  reports: Report[];
  onAdded: (comment: Comment) => void;
  /** Something attached to a Comment changed. */
  onChanged: () => void;
}) {
  const explained = explanations(changes, project);
  const shownInAnother = new Set([...explained.values()].flat().map((c) => c.id));
  const entries: Entry[] = [
    ...changes
      .filter((change) => !shownInAnother.has(change.id))
      .map((change) => ({ at: change.at, key: `change:${change.id}`, kind: "change" as const, change })),
    ...runs.map((run) => ({ at: run.startedAt, key: `run:${run.id}`, kind: "run" as const, run })),
    ...comments
      .filter((c) => c.replyToId === null)
      .map((comment) => ({ at: comment.createdAt, key: `comment:${comment.id}`, kind: "comment" as const, comment })),
    ...reports.map((report) => ({ at: report.createdAt, key: `report:${report.id}`, kind: "report" as const, report })),
    ...transcripts.map((transcript) => ({
      at: transcript.namedAt,
      key: `transcript:${transcript.id}`,
      kind: "transcript" as const,
      transcript,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at) || tieOrder[a.kind] - tieOrder[b.kind]);
  const runOf = new Map(runs.map((run) => [run.id, run]));
  const arrived = useArrivals([...entries.map((e) => e.key), ...comments.map((c) => `comment:${c.id}`)], loaded);

  // New entries scroll the page on only when the User is already at its end.
  const wasAtEnd = useRef(false);
  useEffect(() => {
    const track = () => (wasAtEnd.current = atEnd());
    track();
    window.addEventListener("scroll", track, { passive: true });
    return () => window.removeEventListener("scroll", track);
  }, []);
  useEffect(() => {
    if (arrived.size > 0 && wasAtEnd.current) window.scrollTo({ top: document.documentElement.scrollHeight });
  }, [arrived]);

  const now = new Date();
  let day = "";
  const rows: ReactNode[] = [];
  for (const entry of entries) {
    const thisDay = daySeparator(new Date(entry.at), now);
    if (thisDay !== day) {
      day = thisDay;
      rows.push(
        <li key={`day:${entry.key}`} className="timeline-day">
          <span>{thisDay}</span>
        </li>,
      );
    }
    const isNew = arrived.has(entry.key);
    if (entry.kind === "change") {
      const { change } = entry;
      const run = change.runId ? runOf.get(change.runId) : undefined;
      rows.push(
        <li key={entry.key} className={`entry${isNew ? " arrived" : ""}`}>
          <span className="gutter">
            <span className="ring" />
          </span>
          <p className="entry-line">
            <Actor actor={change.actor.kind === "cronk" ? { kind: "cronk" } : change.actor} />{" "}
            {saysWhy(change) ? describedWithReason(change, explained.get(change.id) ?? []) : described(change)}
            {run && <> in its {run.step.name} Run</>} <RelativeTime at={change.at} clock />
          </p>
        </li>,
      );
    } else if (entry.kind === "run") {
      rows.push(<RunEntry key={entry.key} run={entry.run} project={project} arrived={isNew} />);
    } else if (entry.kind === "transcript") {
      rows.push(<NamingTranscript key={entry.key} transcript={entry.transcript} arrived={isNew} />);
    } else if (entry.kind === "report") {
      const { report } = entry;
      rows.push(
        <li key={entry.key} className={`entry${isNew ? " arrived" : ""}`}>
          <span className="gutter">
            <Avatar actor={{ kind: "agent", name: report.agent.name }} />
          </span>
          <article aria-label={report.title} className="entry-body">
            <p className="entry-head">
              <KindLabel kind="Report" /> <Actor actor={{ kind: "agent", name: report.agent.name }} avatar={false} />{" "}
              <RelativeTime at={report.createdAt} clock />
            </p>
            <div className="report-card">
              <header className="report-card-head">
                <h3>
                  <Link to={`/documents/${report.id}`}>{report.title}</Link>
                </h3>
                <Link to={`/documents/${report.id}`} className="small">
                  Open Report
                </Link>
              </header>
              <div className="markdown-compact">
                <Markdown text={report.body} mentions={[]} />
              </div>
            </div>
          </article>
        </li>,
      );
    } else {
      rows.push(
        <li key={entry.key} className="entry">
          <span className="gutter">
            <Avatar actor={entry.comment.actor} />
          </span>
          <CommentThread
            comment={entry.comment}
            comments={comments}
            ticket={ticket}
            user={user}
            runs={runs}
            depth={0}
            arrived={arrived}
            onAdded={onAdded}
            onChanged={onChanged}
          />
        </li>,
      );
    }
  }
  return (
    <section aria-label="Timeline" className="timeline-section">
      <h2>Timeline</h2>
      {entries.length === 0 ? <p className="muted">Nothing has happened yet.</p> : <ol className="timeline">{rows}</ol>}
    </section>
  );
}

/** A Comment with its replies indented under it; a Question from an Agent shows in a warn box with its answer box. */
function CommentThread({
  comment,
  comments,
  ticket,
  user,
  runs,
  depth,
  arrived,
  onAdded,
  onChanged,
}: {
  comment: Comment;
  comments: Comment[];
  ticket: Ticket;
  user: User;
  runs: Run[];
  depth: number;
  arrived: Set<string>;
  onAdded: (comment: Comment) => void;
  onChanged: () => void;
}) {
  const [replying, setReplying] = useState(false);
  const replies = comments.filter((c) => c.replyToId === comment.id);
  const parent = comment.replyToId ? comments.find((c) => c.id === comment.replyToId) : undefined;
  const question = comment.questionId !== null;
  // The first User's reply answers a Question.
  const answered = question && replies.some((r) => r.actor.kind === "user");
  const askedIn = question ? runs.find((r) => r.question === comment.body && r.questionBy === "agent") : undefined;
  const actor: ActorRef = comment.actor;
  const send = async (body: string) => {
    onAdded(await api.comment(ticket.id, { body, replyToId: comment.id }));
    setReplying(false);
  };
  return (
    <article
      aria-label={`${question ? "Question from" : comment.sentBack ? "Sent back by" : depth > 0 ? "Reply from" : "Comment by"} ${comment.actor.name}`}
      className={`entry-body comment${depth > 0 ? " reply" : ""}${arrived.has(`comment:${comment.id}`) ? " arrived" : ""}`}
    >
      <p className="entry-head">
        {depth === 0 && <KindLabel kind={question ? "Question" : comment.sentBack ? "Sent back" : "Comment"} />}{" "}
        <Actor actor={actor} avatar={depth > 0} /> <RelativeTime at={comment.createdAt} clock />
        {parent && <span className="muted small"> in reply to {parent.actor.name}</span>}
        {question && (answered ? <Chip tone="ok">Answered</Chip> : <Chip tone="warn">Waiting for an answer</Chip>)}
      </p>
      <div className={question ? "bubble bubble-question" : "bubble"}>
        <Markdown text={comment.body} mentions={comment.mentions} />
        <Attachments
          owner={{ kind: "comment", id: comment.id }}
          attachments={comment.attachments}
          label={`Attachments of ${comment.actor.name}'s Comment`}
          // Files are attached to a Comment by its author.
          canAttach={comment.actor.kind === "user" && comment.actor.id === user.id}
          compact
          onChanged={onChanged}
        />
        {replies.length > 0 && (
          <div className="replies">
            {replies.map((reply) => (
              <CommentThread
                key={reply.id}
                comment={reply}
                comments={comments}
                ticket={ticket}
                user={user}
                runs={runs}
                depth={depth + 1}
                arrived={arrived}
                onAdded={onAdded}
                onChanged={onChanged}
              />
            ))}
          </div>
        )}
      </div>
      {question && !answered ? (
        <CommentForm
          label="Answer"
          button="Post answer"
          placeholder={`Answer ${comment.actor.name}… (Markdown)`}
          hint={`The answer sends ${ticket.key} back to ${askedIn ? `the ${askedIn.step.name} Step` : "the Step that asked"}.`}
          onSend={send}
        />
      ) : replying ? (
        <CommentForm label="Reply" button="Send reply" primary={false} onSend={send} />
      ) : (
        depth < 4 && (
          <Button variant="ghost" size="small" onClick={() => setReplying(true)}>
            Reply
          </Button>
        )
      )}
    </article>
  );
}

/**
 * A Transcript of a session outside a Run, such as Claude Code connected by hand, as one line where its Cronk tool
 * calls first named the Ticket: its Agent, how many entries it keeps, and a link to it.
 */
function NamingTranscript({ transcript, arrived }: { transcript: TicketTranscript; arrived: boolean }) {
  const agent = { kind: "agent" as const, name: transcript.agent.name };
  return (
    <li className={`entry entry-run${arrived ? " arrived" : ""}`}>
      <span className="gutter">
        <Avatar actor={agent} />
      </span>
      <p className="entry-line">
        <KindLabel kind="Transcript" /> <Actor actor={agent} avatar={false} /> named it in a session outside a Run ·{" "}
        {transcript.entryCount} {transcript.entryCount === 1 ? "entry" : "entries"} <RelativeTime at={transcript.namedAt} clock />{" "}
        <Link to={`/transcripts/${transcript.id}`} className="small">
          Transcript
        </Link>
      </p>
    </li>
  );
}

/** A Run on the timeline as one line: its state, Step, Agent and model, the Outcome it chose, and its Transcript and session. */
function RunEntry({ run, project, arrived }: { run: Run; project: Project; arrived: boolean }) {
  const step = project.statuses.find((s) => s.id === run.step.statusId)?.step;
  const target = step?.outcomes.find((o) => o.name === run.outcome)?.statusId;
  const targetName = project.statuses.find((s) => s.id === target)?.name;
  return (
    <li className={`entry entry-run${arrived ? " arrived" : ""}`}>
      <span className="gutter">
        <Avatar actor={{ kind: "agent", name: run.agent.name }} />
      </span>
      <p className="entry-line">
        <KindLabel kind="Run" /> <RunState state={run.state} />{" "}
        <span>
          {run.step.name} · <span className="actor-agent-name">{run.agent.name}</span> · <ModelLabel model={run.model} />
        </span>
        {run.outcome && (
          <span>
            {" "}
            · {run.outcome}
            {targetName && <> → {targetName}</>}
          </span>
        )}
        {run.endReason && <span className="muted">: {run.endReason}</span>}
        {run.question && run.questionBy === "cronk" && (
          <span>
            , Cronk asking: <q>{run.question}</q>
          </span>
        )}{" "}
        <RelativeTime at={run.startedAt} clock />
        {run.transcriptId && (
          <>
            {" "}
            <Link to={`/transcripts/${run.transcriptId}`} className="small">
              Transcript
            </Link>
          </>
        )}
        {run.transcriptDeleted && <span className="small muted"> Transcript deleted</span>}
        {run.sessionUrl && (
          <>
            {" "}
            <a href={run.sessionUrl} target="_blank" rel="noreferrer" className="small">
              Session
            </a>
          </>
        )}
      </p>
    </li>
  );
}
