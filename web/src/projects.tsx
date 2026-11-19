import { useCallback, useEffect, useRef, useState, type ComponentProps, type DragEvent, type FormEvent, type ReactNode } from "react";
import {
  api,
  nameOf,
  priorities,
  statusKinds,
  type Agent,
  type Member,
  type Priority,
  type Project,
  type ProjectEdit,
  type ProjectSummary,
  type Status,
  type StatusKind,
  type TicketFilter,
  type TicketSummary,
  type Workspace,
} from "./api.js";
import { field, useSubmit } from "./forms.js";
import { usePlace } from "./frame.js";
import { useArrivals, useLatest, useLiveEvents } from "./live.js";
import { Link, navigate } from "./router.js";
import { ProjectDecisions } from "./decisions.js";
import { ProjectDocuments } from "./documents.js";
import { ProjectGlossary } from "./terms.js";
import { RepositoriesSettings } from "./repositories.js";
import { BriefPreview, StepsSettings } from "./steps.js";
import { Avatar } from "./ui/actor.js";
import { Actions, Button, EmptyState, Field, FormError, LiveIndicator, PageHead, Panel, Segmented } from "./ui/controls.js";
import { Chip, PriorityTag, RunState, StatusDot } from "./ui/labels.js";
import { Dialog, DialogActions, DialogClose, Menu, MenuLink } from "./ui/overlays.js";

/** The Workspace's Projects, and a form to create one. */
export function WorkspaceHome({ workspace }: { workspace: Workspace }) {
  usePlace(null);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const latest = useLatest();
  const load = useCallback(
    () => latest(api.projects(workspace.id), setProjects, (e) => setFailure(e.message)),
    [workspace.id, latest],
  );
  useEffect(load, [load]);
  useLiveEvents(workspace.id, (event) => {
    if (event.type === "project.created" || event.type === "reconnected") load();
  });

  const { error, busy, onSubmit } = useSubmit(async (form) => {
    const project = await api.createProject(workspace.id, { name: field(form, "name"), key: field(form, "key") });
    navigate(`/projects/${project.id}`);
  });

  return (
    <div className="page">
      <PageHead title={workspace.name} />
      <FormError error={failure} />
      {projects &&
        (projects.length === 0 ? (
          <EmptyState title="No Projects yet.">A Project holds a product's Tickets and knowledge. Create the first one below.</EmptyState>
        ) : (
          <Panel title="Projects" id="projects" className="panel-flush">
            <ul className="rows">
              {projects.map((project) => (
                <li key={project.id}>
                  <Link to={`/projects/${project.id}`} className="row">
                    <span className="row-title">{project.name}</span> <span className="ticket-key">{project.key}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        ))}
      <Panel title="New Project" id="new-project" description="Its key starts each Ticket's key, such as CRONK-12.">
        <form onSubmit={onSubmit}>
          <div className="form-row">
            <Field label="Project name">
              <input name="name" required maxLength={200} />
            </Field>
            <Field label="Key">
              <input
                name="key"
                required
                pattern="[A-Za-z][A-Za-z0-9]{1,9}"
                title="2 to 10 letters and digits, starting with a letter"
                autoComplete="off"
                className="mono"
              />
            </Field>
          </div>
          <FormError error={error} />
          <Actions>
            <Button type="submit" variant="primary" disabled={busy}>
              Create Project
            </Button>
          </Actions>
        </form>
      </Panel>
    </div>
  );
}

type View = "board" | "list" | "settings" | "documents" | "glossary" | "decisions";

export const priorityLabel = (priority: Priority) => priorities.find((p) => p.priority === priority)!.label;

/** The Project's other pages, in the page head's "…" menu. */
export function ProjectMenu({ project }: { project: ProjectSummary }) {
  const base = `/projects/${project.id}`;
  return (
    <Menu label="More of this Project">
      <MenuLink to={`${base}/documents`}>Documents</MenuLink>
      <MenuLink to={`${base}/glossary`}>Terms</MenuLink>
      <MenuLink to={`${base}/decisions`}>Decisions</MenuLink>
      <MenuLink to={`${base}/settings`}>Project settings</MenuLink>
    </Menu>
  );
}

/** A Project of the Workspace on screen, as a board, as a list, its Documents, its Terms, its Decisions, or its settings. */
export function ProjectScreen({
  workspace,
  projectId,
  view,
  onOtherWorkspace,
}: {
  workspace: Workspace;
  projectId: string;
  view: View;
  /** Offered a Project of another Workspace; returns whether the screen switches to that Workspace. */
  onOtherWorkspace?: (workspaceId: string) => boolean;
}) {
  const [project, setProject] = useState<Project | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tickets, setTickets] = useState<TicketSummary[] | null>(null);
  const [filter, setFilter] = useState<TicketFilter>({});
  const [failure, setFailure] = useState<string | null>(null);
  const otherWorkspace = useRef(onOtherWorkspace);
  otherWorkspace.current = onOtherWorkspace;
  usePlace(view === "documents" ? "documents" : view === "glossary" ? "terms" : view === "decisions" ? "decisions" : "project", projectId);

  useEffect(() => {
    api.project(projectId).then(
      // A Project of another of the User's Workspaces isn't shown under this one's name.
      (found) => {
        if (found.workspaceId === workspace.id) setProject(found);
        else if (!otherWorkspace.current?.(found.workspaceId)) setFailure("No such Project.");
      },
      (e: Error) => setFailure(e.message),
    );
    api.members(workspace.id).then(setMembers, (e: Error) => setFailure(e.message));
    api.agents(workspace.id).then(setAgents, (e: Error) => setFailure(e.message));
  }, [projectId, workspace.id]);

  const latestTickets = useLatest();
  const loadTickets = useCallback(
    () => latestTickets(api.tickets(projectId, filter), setTickets, (e) => setFailure(e.message)),
    [projectId, filter, latestTickets],
  );
  useEffect(loadTickets, [loadTickets]);

  const latestProject = useLatest();
  const loadProject = () => latestProject(api.project(projectId), setProject, (e) => setFailure(e.message));
  useLiveEvents(workspace.id, (event) => {
    if (event.type === "reconnected") {
      loadProject();
      loadTickets();
    } else if (!("projectId" in event) || event.projectId !== projectId) {
      return;
    } else if (event.type === "statuses.changed" || event.type === "project.changed") {
      loadProject();
    } else if (event.type === "ticket.created" || event.type === "ticket.changed") {
      loadTickets();
    }
  });

  if (failure) return <FormError error={failure} />;
  if (!project || !tickets) return <p className="muted">Loading…</p>;
  if (view === "documents") return <ProjectDocuments workspace={workspace} project={project} />;
  if (view === "glossary") return <ProjectGlossary workspace={workspace} project={project} />;
  if (view === "decisions") return <ProjectDecisions workspace={workspace} project={project} />;

  const base = `/projects/${project.id}`;
  const home = { label: workspace.name, to: `/workspaces/${workspace.id}` };
  if (view === "settings") {
    return (
      <div className="page page-settings">
        <PageHead
          crumbs={[home, { label: <span className="mono">{project.key}</span>, to: base }]}
          title="Project settings"
          actions={<ProjectMenu project={project} />}
        />
        <StatusesSettings project={project} onChange={setProject} />
        <StepsSettings project={project} onChange={setProject} />
        <BriefPreview project={project} />
        <DelegationSettings project={project} onChange={setProject} />
        <RepositoriesSettings project={project} />
        <PullRequestAutomationSettings project={project} onChange={setProject} />
      </div>
    );
  }
  const filtered = Object.values(filter).some((value) => value !== undefined);
  return (
    <div className="page">
      <PageHead
        crumbs={[home, { label: <span className="mono">{project.key}</span> }]}
        title={project.name}
        switcher={
          <>
            <LiveIndicator workspaceId={workspace.id} />
            <Segmented
              label="Project views"
              items={[
                { label: "List", to: `${base}/list`, current: view === "list" },
                { label: "Board", to: base, current: view === "board" },
              ]}
            />
          </>
        }
        actions={
          <>
            <ProjectMenu project={project} />
            <NewTicket project={project} onCreated={loadTickets} />
          </>
        }
      />
      <Filters project={project} members={members} filter={filter} onChange={setFilter} />
      {view === "board" && <Board project={project} members={members} agents={agents} tickets={tickets} onMoved={loadTickets} />}
      {view === "list" && <List project={project} members={members} agents={agents} tickets={tickets} filtered={filtered} />}
    </div>
  );
}

function NewTicket({ project, onCreated }: { project: Project; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const { error, busy, onSubmit } = useSubmit(async (form) => {
    await api.createTicket(project.id, { title: field(form, "title") });
    setOpen(false);
    onCreated();
  });
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        New Ticket
      </Button>
      <Dialog open={open} onOpenChange={setOpen} title={`New Ticket in ${project.name}`}>
        <form onSubmit={onSubmit}>
          <Field label="Title">
            <input name="title" required maxLength={300} autoFocus />
          </Field>
          <FormError error={error} />
          <DialogActions>
            <DialogClose asChild>
              <Button>Cancel</Button>
            </DialogClose>
            <Button type="submit" variant="primary" disabled={busy}>
              Create Ticket
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </>
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
      <label className="filter">
        <span className="sr-only">Filter by Status</span>
        <select value={filter.statusId ?? ""} onChange={(e) => set({ statusId: e.target.value || undefined })}>
          <option value="">Any Status</option>
          {project.statuses.map((status) => (
            <option key={status.id} value={status.id}>
              {status.name}
            </option>
          ))}
        </select>
      </label>
      <label className="filter">
        <span className="sr-only">Filter by Assignee</span>
        <select value={filter.assigneeId ?? ""} onChange={(e) => set({ assigneeId: e.target.value || undefined })}>
          <option value="">Anyone</option>
          <option value="none">Nobody</option>
          {members.map(({ user }) => (
            <option key={user.id} value={user.id}>
              {nameOf(user)}
            </option>
          ))}
        </select>
      </label>
      <label className="filter">
        <span className="sr-only">Filter by Priority</span>
        <select
          value={filter.priority ?? ""}
          onChange={(e) => set({ priority: (e.target.value || undefined) as Priority | undefined })}
        >
          <option value="">Any Priority</option>
          {priorities.map(({ priority, label }) => (
            <option key={priority} value={priority}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="filter">
        <span className="sr-only">Filter by Label</span>
        <input placeholder="Label" value={filter.label ?? ""} onChange={(e) => set({ label: e.target.value.trim() || undefined })} />
      </label>
    </div>
  );
}

/** Why a Ticket that needs a Run waits for one, as a Run state's tooltip reads. */
const waitingReasons = {
  runnerSlot: "Runner full",
  runnerPaused: "Runner rate-limited",
  blocked: "Blocked by another Ticket",
} as const;

/** A Ticket's Run state on its card or row: while a Run is running, waiting or has gone wrong; nothing otherwise. */
export function TicketRunState({ ticket }: { ticket: TicketSummary }) {
  if (ticket.waiting) return <RunState state="waiting" reason={waitingReasons[ticket.waiting]} />;
  const state = ticket.lastRun?.state;
  if (state === "running" || state === "failed" || state === "lost" || state === "refused") return <RunState state={state} />;
  return null;
}

/** The Delegate's and Assignee's avatars, each named in its tooltip. */
function People({ ticket, members, agents }: { ticket: TicketSummary; members: Member[]; agents: Agent[] }) {
  const delegate = agents.find((a) => a.id === ticket.delegateId);
  const assignee = members.find((m) => m.user.id === ticket.assigneeId)?.user;
  return (
    <span className="people">
      {delegate && <Avatar actor={{ kind: "agent", name: delegate.name }} title={`Delegate: ${delegate.name}`} />}
      {assignee && <Avatar actor={{ kind: "user", name: nameOf(assignee) }} title={`Assignee: ${nameOf(assignee)}`} />}
    </span>
  );
}

const ticketDrag = "application/x-cronk-ticket";

/** A Ticket on the board: key and Priority, title, Labels, Run state and avatars. */
function Card({ ticket, members, agents, arrived }: { ticket: TicketSummary; members: Member[]; agents: Agent[]; arrived: boolean }) {
  return (
    <Link
      to={`/tickets/${ticket.id}`}
      className={`card${arrived ? " arrived" : ""}`}
      draggable
      onDragStart={(event: DragEvent<HTMLAnchorElement>) => {
        event.dataTransfer.setData(ticketDrag, ticket.id);
        event.dataTransfer.effectAllowed = "move";
      }}
    >
      <span className="ticket-key card-key">{ticket.key}</span> <span className="card-title">{ticket.title}</span>
      <span className="card-priority">
        <PriorityTag priority={ticket.priority} />
      </span>
      <span className="card-meta">
        {ticket.labels.map((label) => (
          <Chip key={label}>{label}</Chip>
        ))}
        <TicketRunState ticket={ticket} />
        <People ticket={ticket} members={members} agents={agents} />
      </span>
    </Link>
  );
}

/** Done and Canceled columns start collapsed. */
const collapsible = (status: Status) => status.kind === "done" || status.kind === "canceled";

const ticketCount = (count: number) => `${count} Ticket${count === 1 ? "" : "s"}`;

function Board({
  project,
  members,
  agents,
  tickets,
  onMoved,
}: {
  project: Project;
  members: Member[];
  agents: Agent[];
  tickets: TicketSummary[];
  onMoved: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  // Opened collapsed columns, until the User leaves the page; nothing is stored.
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const arrived = useArrivals(tickets.map((t) => `${t.id} ${t.statusId}`));

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

  const collapsed = (status: Status) => collapsible(status) && !opened.has(status.id);
  const columns = project.statuses.map((status) => (collapsed(status) ? "44px" : "minmax(0, 1fr)")).join(" ");
  return (
    <>
      <FormError error={error} />
      <section aria-label="Board" className="board" style={{ gridTemplateColumns: columns }}>
        {project.statuses.map((status) => {
          const inStatus = tickets.filter((ticket) => ticket.statusId === status.id);
          const isCollapsed = collapsed(status);
          return (
            <section
              key={status.id}
              aria-label={status.name}
              className={`column${target === status.id ? " column-target" : ""}${isCollapsed ? " column-collapsed" : ""}`}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes(ticketDrag)) return;
                event.preventDefault();
                setTarget(status.id);
              }}
              onDragLeave={() => setTarget(null)}
              onDrop={(event) => void drop(event, status)}
            >
              <header className="column-head">
                {collapsible(status) ? (
                  <button
                    type="button"
                    className="column-toggle"
                    aria-expanded={!isCollapsed}
                    aria-label={`${status.name}, ${ticketCount(inStatus.length)}`}
                    title={isCollapsed ? `Open ${status.name}` : `Collapse ${status.name}`}
                    onClick={() =>
                      setOpened((shown) => {
                        const next = new Set(shown);
                        if (next.has(status.id)) next.delete(status.id);
                        else next.add(status.id);
                        return next;
                      })
                    }
                  >
                    <StatusDot kind={status.kind} />
                    <span className="column-count">{inStatus.length}</span>
                  </button>
                ) : (
                  <StatusDot kind={status.kind} />
                )}
                <h2 className={isCollapsed ? "sr-only" : "column-name"} title={status.name}>
                  {status.name}
                </h2>
                {!collapsible(status) && <span className="column-count">{inStatus.length}</span>}
                {status.step && !isCollapsed && <span className="model-label">{status.step.model}</span>}
              </header>
              {!isCollapsed && (
                <div className="column-cards">
                  {inStatus.map((ticket) => (
                    <Card
                      key={ticket.id}
                      ticket={ticket}
                      members={members}
                      agents={agents}
                      arrived={arrived.has(`${ticket.id} ${ticket.statusId}`)}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </section>
    </>
  );
}

function List({
  project,
  members,
  agents,
  tickets,
  filtered,
}: {
  project: Project;
  members: Member[];
  agents: Agent[];
  tickets: TicketSummary[];
  filtered: boolean;
}) {
  return (
    <section aria-label="List" className="list">
      {tickets.length === 0 &&
        (filtered ? (
          <EmptyState title="No Tickets match these filters.">Clear a filter to see more.</EmptyState>
        ) : (
          <EmptyState title="No Tickets yet.">New Ticket adds one; Agents file Discovered Tickets as they work.</EmptyState>
        ))}
      {project.statuses.map((status) => {
        const inStatus = tickets.filter((ticket) => ticket.statusId === status.id);
        return (
          <section key={status.id} aria-label={status.name} className="list-group">
            <header className="list-head">
              <StatusDot kind={status.kind} />
              <h2>{status.name}</h2>
              <span className="column-count">{inStatus.length}</span>
            </header>
            {inStatus.length > 0 && (
              <ul className="rows panel panel-flush">
                {inStatus.map((ticket) => (
                  <li key={ticket.id}>
                    <Link to={`/tickets/${ticket.id}`} className="row ticket-row">
                      <StatusDot kind={status.kind} name={status.name} alone />
                      <span className="ticket-key">{ticket.key}</span> <span className="row-title">{ticket.title}</span>
                      <span className="row-meta">
                        {ticket.labels.map((label) => (
                          <Chip key={label}>{label}</Chip>
                        ))}
                        <PriorityTag priority={ticket.priority} />
                        <TicketRunState ticket={ticket} />
                        <People ticket={ticket} members={members} agents={agents} />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </section>
  );
}

/** Changes the Project's settings, one toggle at a time, with what went wrong. */
function useProjectEdit(project: Project, onChange: (project: Project) => void) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toggle = async (edit: ProjectEdit) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await api.editProject(project.id, edit));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, toggle };
}

function DelegationSettings({ project, onChange }: { project: Project; onChange: (project: Project) => void }) {
  const { error, busy, toggle } = useProjectEdit(project, onChange);
  return (
    <Panel
      title="Delegation defaults"
      id="delegation"
      description="Under Autonomous Delegation a Step may complete a Ticket itself, as Unverified, until its Assignee Accepts or Reopens it. Sub-Tickets take their parent's setting."
    >
      <label className="check">
        <input
          type="checkbox"
          checked={project.newTicketsDelegated}
          disabled={busy}
          onChange={(e) => void toggle({ newTicketsDelegated: e.target.checked })}
        />
        New Tickets start delegated to their creator's Agent
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={project.autonomousDelegationDefault}
          disabled={busy}
          onChange={(e) => void toggle({ autonomousDelegationDefault: e.target.checked })}
        />
        Tickets first delegated get Autonomous Delegation
      </label>
      <FormError error={error} />
    </Panel>
  );
}

function PullRequestAutomationSettings({ project, onChange }: { project: Project; onChange: (project: Project) => void }) {
  const { error, busy, toggle } = useProjectEdit(project, onChange);
  return (
    <Panel
      title="Pull Request automation"
      id="pull-request-automation"
      description="A merged Pull Request completes the Tickets it links: Verified when a User of this Workspace merged it, otherwise Unverified. Turned off, merges only update the Pull Request's state."
    >
      <label className="check">
        <input
          type="checkbox"
          checked={project.pullRequestAutomation}
          disabled={busy}
          onChange={(e) => void toggle({ pullRequestAutomation: e.target.checked })}
        />
        Merges complete their Tickets
      </label>
      <FormError error={error} />
    </Panel>
  );
}

function StatusesSettings({ project, onChange }: { project: Project; onChange: (project: Project) => void }) {
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
    <Panel
      title="Statuses"
      id="statuses"
      description="The board's columns, in order. Every Project keeps at least one Status of each kind: Backlog, Active, Review, Done and Canceled."
    >
      <FormError error={error} />
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
      <form onSubmit={add}>
        <div className="form-row">
          <Field label="New Status name">
            <input name="name" required maxLength={100} />
          </Field>
          <Field label="New Status kind">
            <KindSelect name="kind" defaultValue="active" />
          </Field>
        </div>
        <Actions>
          <Button type="submit" variant="primary" disabled={busy}>
            Add Status
          </Button>
        </Actions>
      </form>
    </Panel>
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
    <li className="status-row">
      <StatusDot kind={status.kind} />
      <form
        className="status-rename"
        onSubmit={(event) => {
          event.preventDefault();
          void onRename(name);
        }}
      >
        <input aria-label={`Name of ${status.name}`} value={name} required maxLength={100} onChange={(e) => setName(e.target.value)} />
        <Button type="submit" size="small" disabled={busy || name === status.name} aria-label={`Rename ${status.name}`}>
          Rename
        </Button>
      </form>
      <KindSelect aria-label={`Kind of ${status.name}`} value={status.kind} disabled={busy} onChange={(e) => void onKind(e.target.value as StatusKind)} />
      <span className="status-row-tools">
        <Button size="small" disabled={busy || first} aria-label={`Move ${status.name} up`} onClick={() => onMove(-1)}>
          ↑
        </Button>
        <Button size="small" disabled={busy || last} aria-label={`Move ${status.name} down`} onClick={() => onMove(1)}>
          ↓
        </Button>
        <Button variant="ghost" size="small" disabled={busy} aria-label={`Remove ${status.name}`} onClick={() => onRemove()}>
          Remove
        </Button>
      </span>
    </li>
  );
}

function KindSelect(props: ComponentProps<"select">) {
  return (
    <select {...props} className="kind-select">
      {statusKinds.map(({ kind, label }) => (
        <option key={kind} value={kind}>
          {label}
        </option>
      ))}
    </select>
  );
}

/** The Workspace / Project scope switch of a knowledge page's head. */
export function ScopeSwitch({
  workspace,
  project,
  kind,
}: {
  workspace: Workspace;
  project: ProjectSummary | null;
  kind: "documents" | "glossary" | "decisions";
}) {
  const [projects, setProjects] = useState<ProjectSummary[]>(project ? [project] : []);
  useEffect(() => {
    api.projects(workspace.id).then(setProjects, () => {});
  }, [workspace.id]);
  return (
    <Segmented
      label="Scope"
      items={[
        { label: "Workspace", to: `/workspaces/${workspace.id}/${kind}`, current: project === null },
        ...projects.map((p) => ({
          label: <span className="mono">{p.key}</span>,
          to: `/projects/${p.id}/${kind}`,
          current: p.id === project?.id,
        })),
      ]}
    />
  );
}

/** Crumbs leading to a Project's or the Workspace's knowledge page. */
export function knowledgeCrumbs(workspace: Workspace, project: ProjectSummary | null, page: ReactNode) {
  const home = { label: workspace.name, to: `/workspaces/${workspace.id}` };
  return project
    ? [home, { label: <span className="mono">{project.key}</span>, to: `/projects/${project.id}` }, { label: page }]
    : [home, { label: page }];
}
