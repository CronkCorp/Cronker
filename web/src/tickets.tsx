import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  api,
  priorities,
  type Change,
  type Comment,
  type Member,
  type Priority,
  type Project,
  type Ticket,
  type TicketEdit,
  type Workspace,
} from "./api.js";
import { field, useSubmit } from "./forms.js";
import { Markdown } from "./markdown.js";
import { priorityLabel } from "./projects.js";
import { Link } from "./router.js";

/** A Ticket: its fields, its description, its Comments and its timeline of Changes. */
export function TicketScreen({ workspace, ticketId }: { workspace: Workspace; ticketId: string }) {
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [timeline, setTimeline] = useState<Change[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadTimeline = useCallback(() => api.timeline(ticketId).then(setTimeline), [ticketId]);

  useEffect(() => {
    const fail = (e: Error) => setFailure(e.message);
    api.ticket(ticketId).then(async (found) => {
      const ticketProject = await api.project(found.projectId);
      // A Ticket of another of the User's Workspaces isn't shown under this one's name.
      if (ticketProject.workspaceId !== workspace.id) return setFailure("No such Ticket.");
      setProject(ticketProject);
      setTicket(found);
    }, fail);
    api.members(workspace.id).then(setMembers, fail);
    api.comments(ticketId).then(setComments, fail);
    loadTimeline().catch(fail);
  }, [ticketId, workspace.id, loadTimeline]);

  const save = async (edit: TicketEdit) => {
    setError(null);
    try {
      setTicket(await api.editTicket(ticketId, edit));
      await loadTimeline();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (failure) return <p role="alert">{failure}</p>;
  if (!ticket || !project) return <p>Loading…</p>;
  return (
    <article className="ticket">
      <p>
        <Link to={`/projects/${project.id}`}>{project.name}</Link>
      </p>
      <h1>
        <span className="muted">{ticket.key}</span> {ticket.title}
      </h1>
      {error && <p role="alert">{error}</p>}
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
          <Comments ticket={ticket} comments={comments} onAdded={(c) => setComments([...comments, c])} />
          <Timeline changes={timeline} />
        </div>
        <Fields ticket={ticket} project={project} members={members} onSave={save} />
      </div>
    </article>
  );
}

function TextFields({ ticket, onSave }: { ticket: Ticket; onSave: (edit: TicketEdit) => Promise<void> }) {
  const [title, setTitle] = useState(ticket.title);
  const [description, setDescription] = useState(ticket.description);
  useEffect(() => {
    setTitle(ticket.title);
    setDescription(ticket.description);
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
  onSave,
}: {
  ticket: Ticket;
  project: Project;
  members: Member[];
  onSave: (edit: TicketEdit) => Promise<void>;
}) {
  const labels = ticket.labels.join(", ");
  return (
    <aside className="fields" aria-label="Fields">
      <label>
        Status
        <select value={ticket.statusId} onChange={(e) => void onSave({ statusId: e.target.value })}>
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
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name}
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
              <strong>{comment.actor.name}</strong> <When at={comment.createdAt} />
              {parent && <span className="muted"> in reply to {parent.actor.name}</span>}
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

const fieldNames: Record<Exclude<Change["field"], "created">, string> = {
  title: "Title",
  description: "Description",
  status: "Status",
  priority: "Priority",
  labels: "Labels",
  assignee: "Assignee",
  dueDate: "Due date",
  estimate: "Estimate",
};

function shown(change: Change, value: unknown): string {
  if (value === null || (Array.isArray(value) && value.length === 0)) return "none";
  if (change.field === "priority") return priorityLabel(value as Priority);
  if (change.field === "status" || change.field === "assignee") return (value as { name: string }).name;
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

function Timeline({ changes }: { changes: Change[] }) {
  return (
    <section aria-label="Timeline" className="timeline">
      <h2>Timeline</h2>
      <ol>
        {changes.map((change) => (
          <li key={change.id}>
            {change.actor.name}{" "}
            {change.field === "created"
              ? "created the Ticket"
              : change.field === "description"
                ? "changed the Description"
                : `changed ${fieldNames[change.field]} from ${shown(change, change.from)} to ${shown(change, change.to)}`}{" "}
            <span className="muted">
              <When at={change.at} />
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
