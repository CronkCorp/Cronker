import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type ReactNode } from "react";
import {
  api,
  nameOf,
  priorities,
  type Agent,
  type Attachment,
  type Change,
  type Comment,
  labelRuleShown,
  type LabelRule,
  type LinkedDocument,
  type DocumentSummary,
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
  type User,
  type Workspace,
} from "./api.js";
import { attachAll, Attachments, FileList } from "./attachments.js";
import { field, useSubmit } from "./forms.js";
import { usePlace } from "./frame.js";
import { useArrivals, useLatest, useLiveEvents } from "./live.js";
import { Markdown } from "./markdown.js";
import { priorityLabel } from "./projects.js";
import { Link } from "./router.js";
import { Actor, Avatar, type ActorRef } from "./ui/actor.js";
import { Actions, Button, daySeparator, Field, FormError, LiveIndicator, PageHead, Panel, RelativeTime } from "./ui/controls.js";
import { Chip, KindLabel, ModelLabel, PriorityTag, RunState, StatusPill } from "./ui/labels.js";
import { Dialog, DialogActions, DialogClose } from "./ui/overlays.js";
import { FieldPicker } from "./ui/picker.js";

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
  const [agents, setAgents] = useState<Agent[]>([]);
  const [relations, setRelations] = useState<TicketRelations | null>(null);
  const [linkedDocuments, setLinkedDocuments] = useState<LinkedDocument[] | null>(null);
  const [projectTickets, setProjectTickets] = useState<TicketSummary[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [dropping, setDropping] = useState(false);
  // Whether the timeline's first load is in, after which new entries are marked as they arrive.
  const [loaded, setLoaded] = useState(false);
  const otherWorkspace = useRef(onOtherWorkspace);
  otherWorkspace.current = onOtherWorkspace;
  usePlace("project", project?.id ?? null);

  const latestTicket = useLatest();
  const latestProject = useLatest();
  const latestComments = useLatest();
  const latestReports = useLatest();
  const latestAttachments = useLatest();
  const latestTimeline = useLatest();
  const latestRuns = useLatest();
  const latestRelations = useLatest();
  const latestLinkedDocuments = useLatest();
  const latestProjectTickets = useLatest();
  const latestReportFiles = useLatest();
  const fail = (e: Error) => setFailure(e.message);
  const loadTimeline = useCallback(() => {
    latestTimeline(api.timeline(ticketId), setTimeline);
    latestRuns(api.runs(ticketId), setRuns);
  }, [ticketId, latestTimeline, latestRuns]);
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
  const loadLinks = useCallback(() => {
    latestRelations(api.relations(ticketId), setRelations, fail);
    latestLinkedDocuments(api.linkedDocuments(ticketId), setLinkedDocuments, fail);
  }, [ticketId, latestRelations, latestLinkedDocuments]);

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
    latestComments(comments, setComments, fail);
    latestTimeline(changes, setTimeline, fail);
    latestRuns(runs, setRuns, fail);
    void Promise.allSettled([comments, changes, runs]).then(() => setLoaded(true));
    loadReports();
    loadAttachments();
    loadLinks();
  }, [ticketId, workspace.id, latestTicket, latestComments, loadReports, latestTimeline, latestRuns, latestProjectTickets, loadAttachments, loadLinks]);

  // What others change shows up as it happens; what this screen saves comes back the same way.
  useLiveEvents(workspace.id, (event) => {
    const all = event.type === "reconnected";
    const thisTicket = !all && "ticketId" in event && event.ticketId === ticketId;
    if (all || (thisTicket && event.type === "ticket.changed")) {
      latestTicket(api.ticket(ticketId), setTicket, fail);
      loadTimeline();
      loadLinks();
    }
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
  if (!ticket || !project || !relations || !linkedDocuments) return <p className="muted">Loading…</p>;
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
          { label: workspace.name, to: `/workspaces/${workspace.id}` },
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
          !editing && (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Edit
            </Button>
          )
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
          <Attachments
            owner={{ kind: "ticket", id: ticket.id }}
            attachments={attachments}
            label="Attachments"
            dropHint="or drop or paste them anywhere on the page"
            onChanged={loadAttachments}
          />
          <Timeline
            loaded={loaded}
            ticket={ticket}
            project={project}
            user={user}
            changes={timeline}
            runs={runs}
            comments={comments}
            reports={reports}
            onAdded={addComment}
            onChanged={loadComments}
          />
          <CommentForm label="New Comment" button="Comment" placeholder="Comment… Markdown, and Ticket keys link" onSend={async (body) => addComment(await api.comment(ticket.id, { body }))} />
        </div>
        <aside className="side" aria-label="Details">
          <Fields ticket={ticket} project={project} members={members} agents={agents} user={user} labels={labelsOf(projectTickets, ticket)} onSave={save} />
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
          <RunCard ticket={ticket} runs={runs} agents={agents} statusModel={status?.step?.model ?? null} onRetried={() => apply(api.retry(ticket.id))} />
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
          <LinkedDocuments
            ticket={ticket}
            workspaceId={workspace.id}
            linked={linkedDocuments}
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

/** The Ticket's fields, each edited in place with a picker. */
function Fields({
  ticket,
  project,
  members,
  agents,
  user,
  labels,
  onSave,
}: {
  ticket: Ticket;
  project: Project;
  members: Member[];
  agents: Agent[];
  user: User;
  /** The Labels to offer. */
  labels: string[];
  onSave: (edit: TicketEdit) => Promise<void>;
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
    <Panel className="side-section fields">
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
      <label className="field-row">
        <span className="field-row-label">Autonomous Delegation</span>
        <span className="field-row-value">
          <input
            type="checkbox"
            checked={ticket.autonomousDelegation === true}
            onChange={(e) => void onSave({ autonomousDelegation: e.target.checked })}
          />
          <span className="muted small">{ticket.autonomousDelegation === null ? "The Project's, once delegated" : "A Step may complete it"}</span>
        </span>
      </label>
      <FieldPicker
        label="Labels"
        value={shownLabels.length ? shownLabels.map((label) => <Chip key={label}>{label}</Chip>) : none}
        options={labels.map((label) => ({ value: label, label }))}
        selected={shownLabels}
        multiple
        onPick={(label) => saveLabels(shownLabels.includes(label) ? shownLabels.filter((l) => l !== label) : [...shownLabels, label])}
        onCreate={(label) => !shownLabels.includes(label) && saveLabels([...shownLabels, label])}
      />
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
    </Panel>
  );
}

/**
 * A Ticket a Run completed: Unverified until the User Accepts it, or Reopens it with a Comment saying why,
 * sending it back to the Step that completed it.
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
  const { error, busy, onSubmit } = useSubmit(async (form) => {
    await onReopen(field(form, "comment"));
    setReopening(false);
  });
  const completing = runs.filter((r) => r.state === "finished").at(-1);
  const by = completing ? `${completing.agent.name}'s Run of the ${completing.step.name} Step` : "A Run";
  return (
    <section aria-label="Verification" className="panel side-section verification">
      <div className="field-row">
        <span className="field-row-label">Verification</span>
        {ticket.verification === "verified" ? <Chip tone="ok">Verified</Chip> : <Chip tone="info">Unverified</Chip>}
      </div>
      {ticket.verification === "verified" ? (
        <p className="muted small">A Run completed this and a User Accepted it.</p>
      ) : (
        <>
          <p className="small">{by} completed this. It is Unverified until you Accept it, or Reopen it to send it back to that Step.</p>
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
      <Dialog open={reopening} onOpenChange={setReopening} title={`Reopen ${ticket.key}`} description="It goes back to the Step that completed it, with your Comment.">
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
  statusModel,
  onRetried,
}: {
  ticket: Ticket;
  runs: Run[];
  agents: Agent[];
  /** The model of the Step it waits for. */
  statusModel: string | null;
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
          {statusModel && <ModelLabel model={statusModel} />}
        </div>
        {delegate && <Actor actor={{ kind: "agent", name: delegate.name }} />}
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
  const { error, busy, onSubmit } = useSubmit(async (form, element) => {
    const ticketKey = field(form, "ticket").trim();
    await api.relate(ticket.id, { kind: field(form, "kind") as RelationKind, ticketKey });
    // Keeps the kind chosen, for adding several of one kind in a row.
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
          <select name="kind" defaultValue="blockedBy" aria-label="Relation">
            {relationGroups.map(({ kind, label }) => (
              <option key={kind} value={kind}>
                {label}
              </option>
            ))}
          </select>
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

/**
 * The Documents linked to the Ticket, each a link to it, with a form to link another of the Ticket's Project or of
 * the Workspace.
 */
function LinkedDocuments({
  ticket,
  workspaceId,
  linked,
  onChanged,
}: {
  ticket: Ticket;
  workspaceId: string;
  linked: LinkedDocument[];
  onChanged: () => void;
}) {
  const [trees, setTrees] = useState<{ project: DocumentSummary[]; workspace: DocumentSummary[] } | null>(null);
  const [unlinkError, setUnlinkError] = useState<string | null>(null);
  const [treesError, setTreesError] = useState<string | null>(null);
  // Page trees aren't live, so they are read again on opening the list and after each link.
  const loadTrees = useCallback(() => {
    Promise.all([
      api.documents({ kind: "project", id: ticket.projectId }),
      api.documents({ kind: "workspace", id: workspaceId }),
    ]).then(
      ([project, workspace]) => {
        setTreesError(null);
        setTrees({ project, workspace });
      },
      (e: Error) => setTreesError(e.message),
    );
  }, [ticket.projectId, workspaceId]);
  useEffect(loadTrees, [loadTrees]);
  const { error, busy, onSubmit } = useSubmit(async (form, element) => {
    await api.linkDocument(ticket.id, field(form, "document"));
    element.reset();
    loadTrees();
    onChanged();
  });
  const unlink = async (documentId: string) => {
    setUnlinkError(null);
    try {
      await api.unlinkDocument(ticket.id, documentId);
      onChanged();
    } catch (e) {
      setUnlinkError(e instanceof Error ? e.message : String(e));
    }
  };
  const isLinked = new Set(linked.map((d) => d.id));
  const unlinked = (documents: DocumentSummary[]) => documents.filter((d) => !isLinked.has(d.id));
  const offered = trees && { project: unlinked(trees.project), workspace: unlinked(trees.workspace) };
  return (
    <section aria-label="Linked Documents" className="panel side-section">
      <h2 className="side-title">Linked Documents</h2>
      {linked.length > 0 && (
        <ul aria-label="Linked Documents" className="side-list">
          {linked.map((document) => (
            <li key={document.id}>
              <Link to={`/documents/${document.id}`}>{document.title}</Link>
              {document.projectId === null && <span className="muted small"> Workspace</span>}{" "}
              <Button variant="ghost" size="small" onClick={() => void unlink(document.id)}>
                Unlink
              </Button>
            </li>
          ))}
        </ul>
      )}
      <FormError error={unlinkError} />
      <FormError error={treesError} />
      <form onSubmit={onSubmit} className="side-form">
        <select name="document" required defaultValue="" onFocus={loadTrees} aria-label="Link a Document">
          <option value="" disabled>
            Link a Document…
          </option>
          {offered &&
            (
              [
                ["This Project", offered.project],
                ["The Workspace", offered.workspace],
              ] as const
            ).map(
              ([label, documents]) =>
                documents.length > 0 && (
                  <optgroup key={label} label={label}>
                    {documents.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.title}
                      </option>
                    ))}
                  </optgroup>
                ),
            )}
        </select>
        <div>
          <Button type="submit" size="small" disabled={busy}>
            Link
          </Button>
        </div>
      </form>
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
  onSend,
}: {
  label: string;
  button: string;
  placeholder?: string;
  hint?: ReactNode;
  primary?: boolean;
  onSend: (body: string) => Promise<void>;
}) {
  const { error, busy, onSubmit } = useSubmit((form) => onSend(field(form, "body")));
  return (
    <form
      className="comment-form"
      onSubmit={async (event: FormEvent<HTMLFormElement>) => {
        const form = event.currentTarget;
        await onSubmit(event);
        form.reset();
      }}
    >
      <label className="field">
        <span className="sr-only">{label}</span>
        <textarea name="body" required rows={3} placeholder={placeholder ?? label} className="markdown-source" />
      </label>
      <FormError error={error} />
      <Actions>
        <Button type="submit" variant={primary ? "primary" : "secondary"} disabled={busy}>
          {button}
        </Button>
        {hint && <span className="muted small">{hint}</span>}
      </Actions>
    </form>
  );
}

const fieldNames: Record<
  Exclude<Change["field"], "created" | "subTicket" | "stepSkipped" | "dismissed" | "linkedDocument" | RelationKind>,
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

/** What a `stepSkipped` Change records: the Status whose Step was skipped, its Label rule and the default Outcome. */
interface StepSkipped {
  status: { id: string; name: string };
  labelRule: LabelRule;
  outcome: string;
}

function described(change: Change): string {
  if (change.field === "created") return "created the Ticket";
  if (change.field === "dismissed") return "dismissed it from the Inbox";
  if (change.field === "stepSkipped") {
    const { status, labelRule, outcome } = change.to as StepSkipped;
    return `skipped the ${status.name} Step (${labelRuleShown(labelRule)}), moving on by ${outcome}`;
  }
  if (change.field === "description") return "changed the Description";
  if (change.field === "linkedDocument") {
    return change.to
      ? `linked the Document ${(change.to as { title: string }).title}`
      : `unlinked the Document ${(change.from as { title: string }).title}`;
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
  | { at: string; key: string; kind: "report"; report: Report };

/** Whether the page is scrolled to its end, where new entries may scroll it on. */
const atEnd = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 48;

/** The Ticket's one chronology: its Comments (with their replies), Reports, Runs and Changes, oldest first. */
function Timeline({
  loaded,
  ticket,
  project,
  user,
  changes,
  runs,
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
  comments: Comment[];
  reports: Report[];
  onAdded: (comment: Comment) => void;
  /** Something attached to a Comment changed. */
  onChanged: () => void;
}) {
  const entries: Entry[] = [
    ...changes.map((change) => ({ at: change.at, key: `change:${change.id}`, kind: "change" as const, change })),
    ...runs.map((run) => ({ at: run.startedAt, key: `run:${run.id}`, kind: "run" as const, run })),
    ...comments.filter((c) => c.replyToId === null).map((comment) => ({ at: comment.createdAt, key: `comment:${comment.id}`, kind: "comment" as const, comment })),
    ...reports.map((report) => ({ at: report.createdAt, key: `report:${report.id}`, kind: "report" as const, report })),
  ].sort((a, b) => a.at.localeCompare(b.at));
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
        <li key={`day:${entry.key}`} className="timeline-day" aria-hidden="true">
          <span>{thisDay}</span>
        </li>,
      );
    }
    const isNew = arrived.has(entry.key);
    if (entry.kind === "change") {
      const { change } = entry;
      const run = change.runId ? runOf.get(change.runId) : undefined;
      rows.push(
        <li key={entry.key} className={`entry entry-change${isNew ? " arrived" : ""}`}>
          <span className="gutter">
            <span className="ring" />
          </span>
          <p className="entry-line">
            <Actor actor={change.actor.kind === "cronk" ? { kind: "cronk" } : change.actor} /> {described(change)}
            {run && <> in its {run.step.name} Run</>} <RelativeTime at={change.at} clock />
          </p>
        </li>,
      );
    } else if (entry.kind === "run") {
      rows.push(<RunEntry key={entry.key} run={entry.run} project={project} arrived={isNew} />);
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
      aria-label={`${question ? "Question from" : depth > 0 ? "Reply from" : "Comment by"} ${comment.actor.name}`}
      className={`entry-body comment${depth > 0 ? " reply" : ""}${arrived.has(`comment:${comment.id}`) ? " arrived" : ""}`}
    >
      <p className="entry-head">
        {depth === 0 && <KindLabel kind={question ? "Question" : "Comment"} />}{" "}
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

/** A Run on the timeline as one line: its state, Step, Agent and model, and the Outcome it chose. */
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
