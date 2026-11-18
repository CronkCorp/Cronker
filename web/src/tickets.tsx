import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  api,
  nameOf,
  priorities,
  type Agent,
  type Change,
  type Comment,
  labelRuleShown,
  type LabelRule,
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
import { field, useSubmit } from "./forms.js";
import { useLatest, useLiveEvents } from "./live.js";
import { Markdown } from "./markdown.js";
import { priorityLabel } from "./projects.js";
import { Link } from "./router.js";

/** A Ticket: its fields, its description, its Reports, its Relations, its Comments and its timeline of Changes. */
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
  const [timeline, setTimeline] = useState<Change[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [relations, setRelations] = useState<TicketRelations | null>(null);
  const [projectTickets, setProjectTickets] = useState<TicketSummary[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const otherWorkspace = useRef(onOtherWorkspace);
  otherWorkspace.current = onOtherWorkspace;

  const latestTicket = useLatest();
  const latestProject = useLatest();
  const latestComments = useLatest();
  const latestReports = useLatest();
  const latestTimeline = useLatest();
  const latestRuns = useLatest();
  const latestRelations = useLatest();
  const latestProjectTickets = useLatest();
  const fail = (e: Error) => setFailure(e.message);
  const loadTimeline = useCallback(() => {
    latestTimeline(api.timeline(ticketId), setTimeline);
    latestRuns(api.runs(ticketId), setRuns);
  }, [ticketId, latestTimeline, latestRuns]);
  const loadRelations = useCallback(
    () => latestRelations(api.relations(ticketId), setRelations, fail),
    [ticketId, latestRelations],
  );

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
    latestComments(api.comments(ticketId), setComments, fail);
    latestReports(api.reports(ticketId), setReports, fail);
    latestTimeline(api.timeline(ticketId), setTimeline, fail);
    latestRuns(api.runs(ticketId), setRuns, fail);
    loadRelations();
  }, [ticketId, workspace.id, latestTicket, latestComments, latestReports, latestTimeline, latestRuns, latestProjectTickets, loadRelations]);

  // What others change shows up as it happens; what this screen saves comes back the same way.
  useLiveEvents(workspace.id, (event) => {
    const all = event.type === "reconnected";
    const thisTicket = !all && "ticketId" in event && event.ticketId === ticketId;
    if (all || (thisTicket && event.type === "ticket.changed")) {
      latestTicket(api.ticket(ticketId), setTicket, fail);
      loadTimeline();
      loadRelations();
    }
    if (all || (thisTicket && event.type === "comment.added")) latestComments(api.comments(ticketId), setComments, fail);
    if (all || (thisTicket && event.type === "report.added")) latestReports(api.reports(ticketId), setReports, fail);
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
      loadRelations();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const save = (edit: TicketEdit) => apply(api.editTicket(ticketId, edit));

  // The live refetch may have shown the new Comment already.
  const addComment = (comment: Comment) =>
    setComments((shown) => (shown.some((c) => c.id === comment.id) ? shown : [...shown, comment]));

  if (failure) return <p role="alert">{failure}</p>;
  if (!ticket || !project || !relations) return <p>Loading…</p>;
  return (
    <article className="ticket">
      <p>
        <Link to={`/projects/${project.id}`}>{project.name}</Link>
      </p>
      <h1>
        <span className="muted">{ticket.key}</span> {ticket.title}
      </h1>
      {error && <p role="alert">{error}</p>}
      {ticket.verification && (
        <Verification
          ticket={ticket}
          runs={runs}
          onAccept={() => apply(api.acceptTicket(ticket.id))}
          onReopen={async (comment) => {
            const reopened = api.reopenTicket(ticket.id, comment);
            await apply(reopened);
            await reopened;
            latestComments(api.comments(ticketId), setComments, fail);
          }}
        />
      )}
      <div className="ticket-layout">
        <div>
          <TextFields ticket={ticket} onSave={save} />
          <section aria-label="Description" className="description">
            {ticket.description ? (
              <Markdown text={ticket.description} mentions={ticket.mentions} />
            ) : (
              <p className="muted">No description.</p>
            )}
          </section>
          <Reports reports={reports} />
          <Relations
            ticket={ticket}
            relations={relations}
            suggestions={projectTickets.filter((t) => t.id !== ticket.id)}
            onChanged={() => {
              loadRelations();
              loadTimeline();
            }}
          />
          <Comments ticket={ticket} comments={comments} onAdded={addComment} />
          <Timeline changes={timeline} runs={runs} />
        </div>
        <Fields
          ticket={ticket}
          project={project}
          members={members}
          agents={agents}
          user={user}
          projectTickets={projectTickets.filter((t) => t.id !== ticket.id)}
          onSave={save}
        />
      </div>
    </article>
  );
}

function TextFields({ ticket, onSave }: { ticket: Ticket; onSave: (edit: TicketEdit) => Promise<void> }) {
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
  const { busy, onSubmit } = useSubmit(() => onSave({ title, description }));
  return (
    <form onSubmit={onSubmit}>
      <label>
        Title
        <input value={title} required maxLength={300} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        Edit description
        <textarea value={description} rows={6} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <div>
        <button type="submit" disabled={busy || (title === ticket.title && description === ticket.description)}>
          Save
        </button>
      </div>
    </form>
  );
}

/** One field saved on its own when submitted or left. */
function FieldForm({ children, onSave }: { children: ReactNode; onSave: (form: FormData) => Promise<void> }) {
  const { onSubmit } = useSubmit(onSave);
  return (
    <form
      onSubmit={onSubmit}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.requestSubmit();
      }}
    >
      {children}
    </form>
  );
}

function Fields({
  ticket,
  project,
  members,
  agents,
  user,
  projectTickets,
  onSave,
}: {
  ticket: Ticket;
  project: Project;
  members: Member[];
  agents: Agent[];
  user: User;
  /** The other Tickets of the Project, any of which may become the parent. */
  projectTickets: TicketSummary[];
  onSave: (edit: TicketEdit) => Promise<void>;
}) {
  const labels = ticket.labels.join(", ");
  return (
    <aside className="fields" aria-label="Fields">
      <label>
        Status
        <select
          value={ticket.statusId}
          // An Unverified Ticket leaves its Done Status only by Accept or Reopen.
          disabled={ticket.verification === "unverified"}
          onChange={(e) => void onSave({ statusId: e.target.value })}
        >
          {project.statuses.map((status) => (
            <option key={status.id} value={status.id}>
              {status.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Priority
        <select value={ticket.priority} onChange={(e) => void onSave({ priority: e.target.value as Priority })}>
          {priorities.map(({ priority, label }) => (
            <option key={priority} value={priority}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Assignee
        <select
          value={ticket.assigneeId ?? ""}
          onChange={(e) => void onSave({ assigneeId: e.target.value || null })}
        >
          <option value="">Nobody</option>
          {members.map(({ user }) => (
            <option key={user.id} value={user.id}>
              {user.email}
            </option>
          ))}
        </select>
      </label>
      <Delegation ticket={ticket} agents={agents} user={user} onSave={onSave} />
      <label>
        Parent
        <select value={ticket.parentId ?? ""} onChange={(e) => void onSave({ parentId: e.target.value || null })}>
          <option value="">None</option>
          {projectTickets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.key} {t.title}
            </option>
          ))}
        </select>
      </label>
      <FieldForm
        key={`labels:${labels}`}
        onSave={async (form) => {
          const next = field(form, "labels")
            .split(",")
            .map((l) => l.trim())
            .filter(Boolean);
          if (next.join(", ") !== labels) await onSave({ labels: next });
        }}
      >
        <label>
          Labels
          <input name="labels" defaultValue={labels} placeholder="Separated by commas" />
        </label>
      </FieldForm>
      <FieldForm
        key={`due:${ticket.dueDate}`}
        onSave={async (form) => {
          const next = field(form, "dueDate") || null;
          if (next !== ticket.dueDate) await onSave({ dueDate: next });
        }}
      >
        <label>
          Due date
          <input name="dueDate" type="date" defaultValue={ticket.dueDate ?? ""} />
        </label>
      </FieldForm>
      <FieldForm
        key={`estimate:${ticket.estimate}`}
        onSave={async (form) => {
          const text = field(form, "estimate");
          const next = text === "" ? null : Number(text);
          if (next !== ticket.estimate) await onSave({ estimate: next });
        }}
      >
        <label>
          Estimate
          <input name="estimate" type="number" min={0} step="any" defaultValue={ticket.estimate ?? ""} />
        </label>
      </FieldForm>
    </aside>
  );
}

/**
 * The Delegation toggle: hands the Ticket to one of the signed-in User's own Agents, so it gets
 * Runs, or takes it back. Cronk refuses what isn't allowed, such as delegating someone else's Ticket.
 */
function Delegation({
  ticket,
  agents,
  user,
  onSave,
}: {
  ticket: Ticket;
  agents: Agent[];
  user: User;
  onSave: (edit: TicketEdit) => Promise<void>;
}) {
  const own = agents.filter((a) => a.owner.id === user.id);
  const delegate = agents.find((a) => a.id === ticket.delegateId);
  const [chosen, setChosen] = useState<string>("");
  const pick = chosen || own[0]?.id || "";
  return (
    <fieldset className="delegation">
      <legend>Delegation</legend>
      <label className="check">
        <input
          type="checkbox"
          checked={ticket.delegateId !== null}
          disabled={ticket.delegateId === null && !pick}
          onChange={(e) => void onSave({ delegateId: e.target.checked ? pick : null })}
        />
        {delegate ? `Delegated to ${delegate.name}` : "Delegate to an Agent"}
      </label>
      {ticket.delegateId === null && own.length > 1 && (
        <label>
          Agent
          <select value={pick} onChange={(e) => setChosen(e.target.value)}>
            {own.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {ticket.delegateId === null && own.length === 0 && (
        <p className="muted">You have no Agent in this Workspace to delegate to.</p>
      )}
      {delegate && delegate.owner.id !== user.id && <p className="muted">{nameOf(delegate.owner)}'s Agent.</p>}
      <label className="check">
        <input
          type="checkbox"
          checked={ticket.autonomousDelegation === true}
          onChange={(e) => void onSave({ autonomousDelegation: e.target.checked })}
        />
        Autonomous Delegation: a Step may complete it, as Unverified
      </label>
      {ticket.autonomousDelegation === null && (
        <p className="muted">Until set, it takes the Project's setting when first delegated.</p>
      )}
    </fieldset>
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
    <section aria-label="Verification" className={`verification ${ticket.verification}`}>
      {ticket.verification === "verified" ? (
        <p>
          <strong>Verified.</strong> A Run completed this and a User Accepted it.
        </p>
      ) : (
        <>
          <p>
            <strong>{by} completed this. It is Unverified</strong> until you Accept it, or Reopen it to send it back to
            that Step.
          </p>
          {reopening ? (
            <form onSubmit={onSubmit}>
              <label>
                Why reopen it?
                <textarea name="comment" required rows={3} autoFocus />
              </label>
              {error && <p role="alert">{error}</p>}
              <div className="actions">
                <button type="submit" disabled={busy}>
                  Reopen
                </button>
                <button type="button" className="link" onClick={() => setReopening(false)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <div className="actions">
              <button type="button" onClick={() => void onAccept()}>
                Accept
              </button>
              <button type="button" className="secondary" onClick={() => setReopening(true)}>
                Reopen
              </button>
            </div>
          )}
        </>
      )}
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
    <Link to={`/tickets/${ticket.id}`}>
      {ticket.key} {ticket.title}
    </Link>
  );
}

/** The Ticket's parent, Sub-Tickets, blockers, what it blocks and what it relates to, with a form to add a Relation. */
function Relations({
  ticket,
  relations,
  suggestions,
  onChanged,
}: {
  ticket: Ticket;
  relations: TicketRelations;
  /** Tickets to offer while typing a key; any Ticket of the Workspace may be named. */
  suggestions: TicketSummary[];
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
    <section aria-label="Relations" className="relations">
      <h2>Relations</h2>
      {parent && (
        <p>
          Sub-Ticket of <TicketLink ticket={parent} />
        </p>
      )}
      {subTickets.length > 0 && (
        <>
          <h3 id="sub-tickets">Sub-Tickets</h3>
          <ul aria-labelledby="sub-tickets">
            {subTickets.map((sub) => (
              <li key={sub.id}>
                <TicketLink ticket={sub} />
              </li>
            ))}
          </ul>
        </>
      )}
      {relationGroups.map(({ kind, label }) => {
        const inGroup = relations.relations.filter((r) => r.kind === kind);
        if (inGroup.length === 0) return null;
        return (
          <div key={kind}>
            <h3 id={`relations-${kind}`}>{label}</h3>
            <ul aria-labelledby={`relations-${kind}`}>
              {inGroup.map((relation) => (
                <li key={relation.id}>
                  <TicketLink ticket={relation.ticket} />{" "}
                  <button type="button" className="link" onClick={() => void remove(relation.id)}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {removeError && <p role="alert">{removeError}</p>}
      <form onSubmit={onSubmit} className="relation-form">
        <label>
          Relation
          <select name="kind" defaultValue="blockedBy">
            {relationGroups.map(({ kind, label }) => (
              <option key={kind} value={kind}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Ticket
          <input name="ticket" required list="relation-tickets" placeholder="Key, such as CRONK-12" />
        </label>
        <datalist id="relation-tickets">
          {suggestions.map((t) => (
            <option key={t.id} value={t.key}>
              {t.title}
            </option>
          ))}
        </datalist>
        <button type="submit" disabled={busy}>
          Add
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

/** What the Ticket's Runs wrote, oldest first; shown only once there is one. */
function Reports({ reports }: { reports: Report[] }) {
  if (reports.length === 0) return null;
  return (
    <section aria-label="Reports" className="reports">
      <h2>Reports</h2>
      {reports.map((report) => (
        <article key={report.id} aria-label={report.title} className="comment">
          <h3>{report.title}</h3>
          <div className="comment-meta">
            <strong>{report.agent.name}</strong> <span className="muted">(Agent)</span> <When at={report.createdAt} />
          </div>
          <Markdown text={report.body} mentions={[]} />
        </article>
      ))}
    </section>
  );
}

function When({ at }: { at: string }) {
  return <time dateTime={at}>{new Date(at).toLocaleString()}</time>;
}

function Comments({
  ticket,
  comments,
  onAdded,
}: {
  ticket: Ticket;
  comments: Comment[];
  onAdded: (comment: Comment) => void;
}) {
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const byId = new Map(comments.map((c) => [c.id, c]));

  // Each thread in order: a Comment, then the replies under it, depth first.
  const thread = (parent: string | null, depth: number): { comment: Comment; depth: number }[] =>
    comments
      .filter((c) => c.replyToId === parent)
      .flatMap((comment) => [{ comment, depth }, ...thread(comment.id, depth + 1)]);

  const send = async (body: string, replyToId?: string) => {
    onAdded(await api.comment(ticket.id, { body, replyToId }));
    setReplyingTo(null);
  };

  return (
    <section aria-label="Comments" className="comments">
      <h2>Comments</h2>
      {thread(null, 0).map(({ comment, depth }) => {
        const parent = comment.replyToId ? byId.get(comment.replyToId) : undefined;
        return (
          <article key={comment.id} className="comment" style={{ marginLeft: `${Math.min(depth, 4) * 1.5}rem` }}>
            <div className="comment-meta">
              <strong>{comment.actor.name}</strong>
              {comment.actor.kind === "agent" && <span className="muted"> (Agent)</span>} <When at={comment.createdAt} />
              {parent && <span className="muted"> in reply to {parent.actor.name}</span>}
              {comment.questionId && <span className="badge">Question</span>}
            </div>
            <Markdown text={comment.body} mentions={comment.mentions} />
            {replyingTo === comment.id ? (
              <CommentForm label="Reply" button="Send reply" onSend={(body) => send(body, comment.id)} />
            ) : (
              <button type="button" className="link" onClick={() => setReplyingTo(comment.id)}>
                Reply
              </button>
            )}
          </article>
        );
      })}
      <CommentForm label="New Comment" button="Comment" onSend={(body) => send(body)} />
    </section>
  );
}

function CommentForm({ label, button, onSend }: { label: string; button: string; onSend: (body: string) => Promise<void> }) {
  const { error, busy, onSubmit } = useSubmit((form) => onSend(field(form, "body")));
  return (
    <form
      onSubmit={async (event: FormEvent<HTMLFormElement>) => {
        const form = event.currentTarget;
        await onSubmit(event);
        form.reset();
      }}
    >
      <label>
        {label}
        <textarea name="body" required rows={3} />
      </label>
      {error && <p role="alert">{error}</p>}
      <div>
        <button type="submit" disabled={busy}>
          {button}
        </button>
      </div>
    </form>
  );
}

const fieldNames: Record<Exclude<Change["field"], "created" | "subTicket" | "stepSkipped" | "dismissed" | RelationKind>, string> = {
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

const runStateShown: Record<Run["state"], string> = {
  running: "running",
  finished: "finished",
  failed: "failed",
  lost: "lost",
  stopped: "stopped",
  refused: "couldn't start",
};

/** A Run on the timeline: its Step, Agent and model, where it stands, its times and its session. */
function RunEntry({ run }: { run: Run }) {
  return (
    <li className="run-entry">
      {run.agent.name} ran the {run.step.name} Step on {run.model}:{" "}
      <span className={`run-state ${run.state}`}>{runStateShown[run.state]}</span>
      {run.outcome && <> with {run.outcome}</>}
      {run.endReason && <>: {run.endReason}</>}
      {run.question && (
        <>
          , {run.questionBy === "cronk" ? "Cronk" : run.agent.name} asking: <q>{run.question}</q>
        </>
      )}{" "}
      <span className="muted">
        <When at={run.startedAt} />
        {run.endedAt && (
          <>
            {" to "}
            <When at={run.endedAt} />
          </>
        )}
      </span>
      {run.sessionUrl && (
        <>
          {" "}
          <a href={run.sessionUrl} target="_blank" rel="noreferrer">
            Session
          </a>
        </>
      )}
    </li>
  );
}

/** The Ticket's Changes and Runs, oldest first. */
function Timeline({ changes, runs }: { changes: Change[]; runs: Run[] }) {
  const entries = [
    ...changes.map((change) => ({ at: change.at, key: `change:${change.id}`, change })),
    ...runs.map((run) => ({ at: run.startedAt, key: `run:${run.id}`, run })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const runOf = new Map(runs.map((run) => [run.id, run]));
  return (
    <section aria-label="Timeline" className="timeline">
      <h2>Timeline</h2>
      <ol>
        {entries.map((entry) =>
          "run" in entry ? (
            <RunEntry key={entry.key} run={entry.run} />
          ) : (
            <li key={entry.key}>
              {entry.change.actor.name} {described(entry.change)}
              {entry.change.runId && runOf.has(entry.change.runId) && (
                <> in its {runOf.get(entry.change.runId)!.step.name} Run</>
              )}{" "}
              <span className="muted">
                <When at={entry.change.at} />
              </span>
            </li>
          ),
        )}
      </ol>
    </section>
  );
}
