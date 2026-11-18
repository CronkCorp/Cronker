import { useCallback, useEffect, useState, type ComponentProps, type DragEvent, type FormEvent } from "react";
import {
  api,
  priorities,
  statusKinds,
  type Member,
  type Priority,
  type Project,
  type ProjectSummary,
  type Status,
  type StatusKind,
  type TicketFilter,
  type TicketSummary,
  type Workspace,
} from "./api.js";
import { field, useSubmit } from "./forms.js";
import { Link, navigate } from "./router.js";

const kindLabel = (kind: StatusKind) => statusKinds.find((k) => k.kind === kind)!.label;

/** The Workspace's Projects, and a form to create one. */
export function WorkspaceHome({ workspace }: { workspace: Workspace }) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    api.projects(workspace.id).then(setProjects, (e: Error) => setFailure(e.message));
  }, [workspace.id]);

  const { error, busy, onSubmit } = useSubmit(async (form) => {
    const project = await api.createProject(workspace.id, { name: field(form, "name"), key: field(form, "key") });
    navigate(`/projects/${project.id}`);
  });

  return (
    <>
      <h1>{workspace.name}</h1>
      {failure && <p role="alert">{failure}</p>}
      {projects &&
        (projects.length === 0 ? (
          <p>No Projects yet.</p>
        ) : (
          <ul className="projects">
            {projects.map((project) => (
              <li key={project.id}>
                <Link to={`/projects/${project.id}`}>{project.name}</Link> <span className="muted">{project.key}</span>
              </li>
            ))}
          </ul>
        ))}
      <h2>New Project</h2>
      <form onSubmit={onSubmit} className="inline">
        <label>
          Project name
          <input name="name" required maxLength={200} />
        </label>
        <label>
          Key
          <input
            name="key"
            required
            pattern="[A-Za-z][A-Za-z0-9]{1,9}"
            title="2 to 10 letters and digits, starting with a letter"
            autoComplete="off"
          />
        </label>
        <button type="submit" disabled={busy}>
          Create Project
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
    </>
  );
}

type View = "board" | "list" | "settings";

export const priorityLabel = (priority: Priority) => priorities.find((p) => p.priority === priority)!.label;

/** A Project of the Workspace on screen, as a board, as a list, or its settings. */
export function ProjectScreen({ workspace, projectId, view }: { workspace: Workspace; projectId: string; view: View }) {
  const [project, setProject] = useState<Project | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [tickets, setTickets] = useState<TicketSummary[] | null>(null);
  const [filter, setFilter] = useState<TicketFilter>({});
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    api.project(projectId).then(
      // A Project of another of the User's Workspaces isn't shown under this one's name.
      (found) => (found.workspaceId === workspace.id ? setProject(found) : setFailure("No such Project.")),
      (e: Error) => setFailure(e.message),
    );
    api.members(workspace.id).then(setMembers, (e: Error) => setFailure(e.message));
  }, [projectId, workspace.id]);

  const loadTickets = useCallback(() => {
    let current = true;
    api.tickets(projectId, filter).then(
      (found) => current && setTickets(found),
      (e: Error) => current && setFailure(e.message),
    );
    return () => {
      current = false;
    };
  }, [projectId, filter]);
  useEffect(loadTickets, [loadTickets]);

  if (failure) return <p role="alert">{failure}</p>;
  if (!project || !tickets) return <p>Loading…</p>;
  const base = `/projects/${project.id}`;
  return (
    <>
      <h1>
        {project.name} <span className="muted">{project.key}</span>
      </h1>
      <nav className="tabs" aria-label="Project views">
        <Link to={base} current={view === "board"}>
          Board
        </Link>
        <Link to={`${base}/list`} current={view === "list"}>
          List
        </Link>
        <Link to={`${base}/settings`} current={view === "settings"}>
          Settings
        </Link>
      </nav>
      {view !== "settings" && (
        <>
          <NewTicket project={project} onCreated={loadTickets} />
          <Filters project={project} members={members} filter={filter} onChange={setFilter} />
        </>
      )}
      {view === "board" && <Board project={project} members={members} tickets={tickets} onMoved={loadTickets} />}
      {view === "list" && (
        <List
          project={project}
          members={members}
          tickets={tickets}
          filtered={Object.values(filter).some((value) => value !== undefined)}
        />
      )}
      {view === "settings" && <Settings project={project} onChange={setProject} />}
    </>
  );
}

function NewTicket({ project, onCreated }: { project: Project; onCreated: () => void }) {
  const { error, busy, onSubmit } = useSubmit(async (form) => {
    await api.createTicket(project.id, { title: field(form, "title") });
    onCreated();
  });
  return (
    <form
      className="inline"
      onSubmit={async (event) => {
        const form = event.currentTarget;
        await onSubmit(event);
        form.reset();
      }}
    >
      <label>
        New Ticket title
        <input name="title" required maxLength={300} />
      </label>
      <button type="submit" disabled={busy}>
        Create Ticket
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

function Filters({
  project,
  members,
  filter,
  onChange,
}: {
  project: Project;
  members: Member[];
  filter: TicketFilter;
  onChange: (filter: TicketFilter) => void;
}) {
  const set = (change: TicketFilter) => onChange({ ...filter, ...change });
  return (
    <div className="filters" role="group" aria-label="Filters">
      <label>
        Filter by Status
        <select value={filter.statusId ?? ""} onChange={(e) => set({ statusId: e.target.value || undefined })}>
          <option value="">Any</option>
          {project.statuses.map((status) => (
            <option key={status.id} value={status.id}>
              {status.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Filter by Assignee
        <select value={filter.assigneeId ?? ""} onChange={(e) => set({ assigneeId: e.target.value || undefined })}>
          <option value="">Anyone</option>
          <option value="none">Nobody</option>
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Filter by Priority
        <select
          value={filter.priority ?? ""}
          onChange={(e) => set({ priority: (e.target.value || undefined) as Priority | undefined })}
        >
          <option value="">Any</option>
          {priorities.map(({ priority, label }) => (
            <option key={priority} value={priority}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Filter by Label
        <input value={filter.label ?? ""} onChange={(e) => set({ label: e.target.value.trim() || undefined })} />
      </label>
    </div>
  );
}

function TicketItem({
  ticket,
  members,
  draggable,
}: {
  ticket: TicketSummary;
  members: Member[];
  draggable?: boolean;
}) {
  const assignee = members.find((m) => m.id === ticket.assigneeId);
  const details = [
    ticket.priority === "none" ? null : priorityLabel(ticket.priority),
    ...ticket.labels,
    assignee?.name,
  ].filter(Boolean);
  return (
    <Link
      to={`/tickets/${ticket.id}`}
      className="ticket-item"
      draggable={draggable}
      onDragStart={(event: DragEvent<HTMLAnchorElement>) => {
        event.dataTransfer.setData(ticketDrag, ticket.id);
        event.dataTransfer.effectAllowed = "move";
      }}
    >
      <span className="muted">{ticket.key}</span> <span>{ticket.title}</span>
      {details.length > 0 && <small className="muted"> {details.join(" · ")}</small>}
    </Link>
  );
}

const ticketDrag = "application/x-cronk-ticket";

function Board({
  project,
  members,
  tickets,
  onMoved,
}: {
  project: Project;
  members: Member[];
  tickets: TicketSummary[];
  onMoved: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);

  const drop = async (event: DragEvent<HTMLElement>, status: Status) => {
    event.preventDefault();
    setTarget(null);
    const ticketId = event.dataTransfer.getData(ticketDrag);
    if (!ticketId || tickets.find((t) => t.id === ticketId)?.statusId === status.id) return;
    setError(null);
    try {
      await api.editTicket(ticketId, { statusId: status.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    onMoved();
  };

  return (
    <>
      {error && <p role="alert">{error}</p>}
      <section aria-label="Board" className="board">
        {project.statuses.map((status) => (
          <section
            key={status.id}
            aria-label={status.name}
            className={target === status.id ? "lane target" : "lane"}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes(ticketDrag)) return;
              event.preventDefault();
              setTarget(status.id);
            }}
            onDragLeave={() => setTarget(null)}
            onDrop={(event) => void drop(event, status)}
          >
            <h2>{status.name}</h2>
            <p className="muted">{kindLabel(status.kind)}</p>
            {tickets
              .filter((ticket) => ticket.statusId === status.id)
              .map((ticket) => (
                <TicketItem key={ticket.id} ticket={ticket} members={members} draggable />
              ))}
          </section>
        ))}
      </section>
    </>
  );
}

function List({
  project,
  members,
  tickets,
  filtered,
}: {
  project: Project;
  members: Member[];
  tickets: TicketSummary[];
  filtered: boolean;
}) {
  return (
    <section aria-label="List" className="list">
      {tickets.length === 0 && <p>{filtered ? "No Tickets match these filters." : "No Tickets yet."}</p>}
      {project.statuses.map((status) => {
        const inStatus = tickets.filter((ticket) => ticket.statusId === status.id);
        return (
          <section key={status.id} aria-label={status.name}>
            <div className="list-heading">
              <h2>{status.name}</h2>
              <span className="muted">{inStatus.length}</span>
            </div>
            {inStatus.map((ticket) => (
              <TicketItem key={ticket.id} ticket={ticket} members={members} />
            ))}
          </section>
        );
      })}
    </section>
  );
}

function Settings({ project, onChange }: { project: Project; onChange: (project: Project) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (change: () => Promise<Project>) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await change());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void run(async () => {
      const changed = await api.addStatus(project.id, {
        name: field(data, "name"),
        kind: field(data, "kind") as StatusKind,
      });
      form.reset();
      return changed;
    });
  };

  const last = project.statuses.length - 1;
  return (
    <section aria-labelledby="statuses-heading" className="settings">
      <h2 id="statuses-heading">Statuses</h2>
      <p className="muted">
        Every Project keeps at least one Status of each kind: Backlog, Active, Review, Done and Canceled.
      </p>
      {error && <p role="alert">{error}</p>}
      <ol className="statuses">
        {project.statuses.map((status, position) => (
          <StatusRow
            key={status.id}
            status={status}
            busy={busy}
            first={position === 0}
            last={position === last}
            onRename={(name) => run(() => api.editStatus(project.id, status.id, { name }))}
            onKind={(kind) => run(() => api.editStatus(project.id, status.id, { kind }))}
            onMove={(by) => run(() => api.editStatus(project.id, status.id, { position: position + by }))}
            onRemove={() => run(() => api.removeStatus(project.id, status.id))}
          />
        ))}
      </ol>
      <form onSubmit={add} className="inline">
        <label>
          New Status name
          <input name="name" required maxLength={100} />
        </label>
        <label>
          New Status kind
          <KindSelect name="kind" defaultValue="active" />
        </label>
        <button type="submit" disabled={busy}>
          Add Status
        </button>
      </form>
    </section>
  );
}

function StatusRow({
  status,
  busy,
  first,
  last,
  onRename,
  onKind,
  onMove,
  onRemove,
}: {
  status: Status;
  busy: boolean;
  first: boolean;
  last: boolean;
  onRename: (name: string) => Promise<void>;
  onKind: (kind: StatusKind) => Promise<void>;
  onMove: (by: number) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [name, setName] = useState(status.name);
  useEffect(() => setName(status.name), [status.name]);

  return (
    <li>
      <form
        className="inline"
        onSubmit={(event) => {
          event.preventDefault();
          void onRename(name);
        }}
      >
        <input
          aria-label={`Name of ${status.name}`}
          value={name}
          required
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" disabled={busy || name === status.name} aria-label={`Rename ${status.name}`}>
          Rename
        </button>
      </form>
      <KindSelect
        aria-label={`Kind of ${status.name}`}
        value={status.kind}
        disabled={busy}
        onChange={(e) => void onKind(e.target.value as StatusKind)}
      />
      <button type="button" disabled={busy || first} aria-label={`Move ${status.name} up`} onClick={() => onMove(-1)}>
        ↑
      </button>
      <button type="button" disabled={busy || last} aria-label={`Move ${status.name} down`} onClick={() => onMove(1)}>
        ↓
      </button>
      <button type="button" disabled={busy} aria-label={`Remove ${status.name}`} onClick={() => onRemove()}>
        Remove
      </button>
    </li>
  );
}

function KindSelect(props: ComponentProps<"select">) {
  return (
    <select {...props}>
      {statusKinds.map(({ kind, label }) => (
        <option key={kind} value={kind}>
          {label}
        </option>
      ))}
    </select>
  );
}
