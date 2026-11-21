import { addresses, useAddresses } from "./addresses.js";
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
  type TicketEdit,
  type TicketFilter,
  type TicketSummary,
  type User,
  type Workspace,
  type WorkspaceSummary,
} from "./api.js";
import { field, useSave, useSubmit } from "./forms.js";
import { usePlace } from "./frame.js";
import { useArrivals, useLatest, useLiveEvents } from "./live.js";
import { Link, navigate } from "./router.js";
import { ProjectArtifacts } from "./artifacts.js";
import { ProjectDecisions } from "./decisions.js";
import { ProjectDocuments } from "./documents.js";
import { ProjectGlossary } from "./terms.js";
import { RepositoriesSettings } from "./repositories.js";
import { BriefPreview, StepsSettings } from "./steps.js";
import { SettingsLayout } from "./ui/settings.js";
import { Actor, Avatar } from "./ui/actor.js";
import { Actions, Button, EmptyState, Field, FormError, LiveIndicator, PageHead, Panel, Saved, Segmented, workspaceCrumb } from "./ui/controls.js";
import { Chip, Key, ModelLabel, PriorityTag, RunState, StatusDot, StatusPill } from "./ui/labels.js";
import {
  ContextMenu,
  Dialog,
  DialogActions,
  DialogClose,
  HoverPopover,
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuLink,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
} from "./ui/overlays.js";

/** The Workspace's Projects, and a form to create one. */
export function WorkspaceHome({ workspace }: { workspace: Workspace }) {
  const to = useAddresses();
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
    navigate(to.project(project));
  });

  return (
    <div className="page">
      <PageHead crumbs={[{ label: "Workspace" }]} title={workspace.name} />
      <FormError error={failure} />
      {projects &&
        (projects.length === 0 ? (
          <EmptyState title="No Projects yet.">A Project holds a product's Tickets and knowledge. Create the first one below.</EmptyState>
        ) : (
          <Panel title="Projects" id="projects" className="panel-flush">
            <ul className="rows">
              {projects.map((project) => (
                <li key={project.id}>
                  <Link to={to.project(project)} className="row">
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

type View = "board" | "list" | "settings" | "documents" | "glossary" | "decisions" | "artifacts";

export const priorityLabel = (priority: Priority) => priorities.find((p) => p.priority === priority)!.label;

/** The Project's other pages, in the page head's "…" menu. */
export function ProjectMenu({ project }: { project: ProjectSummary }) {
  const to = useAddresses();
  const base = to.project(project);
  return (
    <Menu label="More of this Project">
      <MenuLink to={`${base}/documents`}>Documents</MenuLink>
      <MenuLink to={`${base}/glossary`}>Terms</MenuLink>
      <MenuLink to={`${base}/decisions`}>Decisions</MenuLink>
      <MenuLink to={`${base}/artifacts`}>Artifacts</MenuLink>
      <MenuLink to={`${base}/settings`}>Project settings</MenuLink>
    </Menu>
  );
}

/**
 * A Project of the Workspace on screen, as a board, as a list, its Documents, its Terms, its Decisions, its Artifacts,
 * or its settings.
 */
export function ProjectScreen({
  workspace,
  user,
  projectId,
  view,
}: {
  workspace: WorkspaceSummary;
  /** The signed-in User, who delegates only to their own Agents. */
  user: User;
  projectId: string;
  view: View;
}) {
  const to = useAddresses();
  const [project, setProject] = useState<Project | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tickets, setTickets] = useState<TicketSummary[] | null>(null);
  const [filter, setFilter] = useState<TicketFilter>({});
  const [failure, setFailure] = useState<string | null>(null);
  const areas = { documents: "documents", glossary: "terms", decisions: "decisions", artifacts: "artifacts" } as const;
  usePlace(view in areas ? areas[view as keyof typeof areas] : "project", projectId);

  useEffect(() => {
    api.project(projectId).then(
      // A Project of another of the User's Workspaces isn't shown under this one's name.
      (found) => {
        if (found.workspaceId === workspace.id) setProject(found);
        else setFailure("No such Project.");
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
  if (view === "artifacts") return <ProjectArtifacts workspace={workspace} project={project} />;

  const base = to.project(project);
  const home = workspaceCrumb(workspace);
  if (view === "settings") {
    return (
      <div className="page page-settings">
        <PageHead
          crumbs={[home, { label: <span className="mono">{project.key}</span>, to: base }]}
          title="Project settings"
          actions={<ProjectMenu project={project} />}
        />
        <SettingsLayout
          sections={[
            {
              id: "statuses",
              label: "Statuses and Steps",
              children: (
                <>
                  <StatusesSettings project={project} onChange={setProject} />
                  <StepsSettings project={project} onChange={setProject} />
                  <BriefPreview project={project} />
                </>
              ),
            },
            {
              id: "delegation",
              label: "Delegation defaults",
              children: <DelegationSettings project={project} onChange={setProject} />,
            },
            { id: "repositories", label: "Repositories", children: <RepositoriesSettings project={project} /> },
            {
              id: "pull-request-automation",
              label: "Pull Request automation",
              children: <PullRequestAutomationSettings project={project} onChange={setProject} />,
            },
            {
              id: "merges-by-agents",
              label: "Merges by agents",
              children: <MergesByAgentsSettings workspace={workspace} project={project} onChange={setProject} />,
            },
          ]}
        />
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
      {view === "board" && <Board project={project} members={members} agents={agents} user={user} tickets={tickets} onChanged={loadTickets} />}
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

/**
 * A blocked Ticket's chip on its card or row: *Blocked by N*, counting its unfinished blockers. Hovering or focusing
 * it names them, each a link to its Ticket. An unblocked Ticket shows nothing.
 */
function BlockedChip({ ticket }: { ticket: TicketSummary }) {
  const to = useAddresses();
  const blockers = ticket.blockedBy;
  if (blockers.length === 0) return null;
  return (
    <HoverPopover
      label={`Tickets blocking ${ticket.key}`}
      button={{
        className: "chip chip-blocked",
        "aria-label": `Blocked by ${blockers.length}: ${blockers.map((b) => `${b.key} ${b.title}`).join(", ")}`,
        children: (
          <>
            <svg className="chip-icon" viewBox="0 0 12 12" aria-hidden="true">
              <circle cx="6" cy="6" r="4.75" />
              <path d="M2.7 9.3 9.3 2.7" />
            </svg>
            Blocked by {blockers.length}
          </>
        ),
      }}
    >
      <p className="hover-popover-head">Blocked by</p>
      <ul className="hover-popover-list">
        {blockers.map((blocker) => (
          <li key={blocker.id}>
            <Link to={to.ticket(blocker)} className="ticket-link">
              <Key>{blocker.key}</Key> {blocker.title}
            </Link>
          </li>
        ))}
      </ul>
    </HoverPopover>
  );
}

const ticketDrag = "application/x-cronk-ticket";

/** Whether a drag carries a board card's Ticket. */
const carriesTicket = (event: DragEvent<HTMLElement>) => event.dataTransfer.types.includes(ticketDrag);

/** How near the board's left or right edge a dragged card scrolls it, and how far it scrolls each frame at the edge. */
const edgeZone = 48;
const edgeSpeed = 16;
/** How long the board keeps scrolling after the last dragover: browsers repeat it while a held card stays still. */
const edgeHold = 700;

/**
 * Scrolls the board sideways while a dragged card is held near its left or right edge, faster nearer the edge, so the
 * card reaches columns that start off screen. Only Chromium scrolls a dragged-over element by itself; Firefox and
 * Safari (WebKit) don't.
 */
function useEdgeScroll() {
  const board = useRef<HTMLElement>(null);
  const held = useRef({ speed: 0, at: 0 });
  const frame = useRef<number | null>(null);

  const stop = useCallback(() => {
    held.current.speed = 0;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);
  useEffect(() => stop, [stop]);

  const step = useCallback(() => {
    const { speed, at } = held.current;
    if (!board.current || speed === 0 || performance.now() - at > edgeHold) {
      frame.current = null;
      return;
    }
    const before = board.current.scrollLeft;
    board.current.scrollLeft += speed;
    // At its end the board can't scroll further: stop until the next dragover asks again.
    frame.current = board.current.scrollLeft === before ? null : requestAnimationFrame(step);
  }, []);

  const onDragOver = (event: DragEvent<HTMLElement>) => {
    if (!board.current || !carriesTicket(event)) return;
    const { left, right } = board.current.getBoundingClientRect();
    const fromLeft = event.clientX - left;
    const fromRight = right - event.clientX;
    // Whole pixels: browsers that round scrollLeft would never move on a fraction of one.
    const toward = (distance: number) => (distance < edgeZone ? Math.ceil(edgeSpeed * (1 - distance / edgeZone)) : 0);
    const speed = toward(fromRight) - toward(fromLeft);
    held.current = { speed, at: performance.now() };
    if (speed !== 0 && frame.current === null) frame.current = requestAnimationFrame(step);
  };

  /** A card dragged off the board stops it scrolling, rather than it running on until the hold lapses. */
  const onDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) stop();
  };

  return { ref: board, onDragOver, onDragLeave, stop };
}

/**
 * A card's context menu: Move to its Project's Statuses, Delegate to the User's own Agents or Undelegate, and, while
 * it is delegated, Autonomous Delegation. Each saves at once through `onEdit`, as a drop does; Cronk keeps the rules.
 */
function CardMenu({
  ticket,
  project,
  own,
  onEdit,
}: {
  ticket: TicketSummary;
  project: Project;
  /** The signed-in User's own Agents, the only ones they delegate to. */
  own: Agent[];
  onEdit: (edit: TicketEdit) => void;
}) {
  return (
    <>
      <MenuSub label="Move to">
        <MenuRadioGroup label="Statuses" value={ticket.statusId} onChange={(statusId) => statusId !== ticket.statusId && onEdit({ statusId })}>
          {project.statuses.map((status) => (
            <MenuRadioItem key={status.id} value={status.id}>
              <StatusPill kind={status.kind} name={status.name} model={status.step?.model} />
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuSub>
      <MenuSub label="Delegate to">
        <MenuRadioGroup
          label="Agents"
          value={ticket.delegateId ?? ""}
          onChange={(delegateId) => delegateId !== ticket.delegateId && onEdit({ delegateId })}
        >
          {own.map((agent) => (
            <MenuRadioItem key={agent.id} value={agent.id}>
              <Actor actor={{ kind: "agent", name: agent.name }} />
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        {own.length > 0 && <MenuSeparator />}
        <MenuItem disabled={ticket.delegateId === null} onSelect={() => onEdit({ delegateId: null })}>
          Undelegate
        </MenuItem>
      </MenuSub>
      {ticket.delegateId !== null && (
        <MenuCheckboxItem checked={ticket.autonomousDelegation === true} onChange={(on) => onEdit({ autonomousDelegation: on })}>
          Autonomous Delegation
        </MenuCheckboxItem>
      )}
    </>
  );
}

/**
 * A Ticket on the board: key and Priority, title, Labels, Run state and avatars, all one link, then its Blocked chip,
 * which holds links of its own and so sits beside the card's link rather than in it. Right-clicking it, long-pressing
 * it or ContextMenu / Shift+F10 on its focused link opens its CardMenu.
 */
function Card({
  ticket,
  project,
  members,
  agents,
  own,
  arrived,
  onEdit,
}: {
  ticket: TicketSummary;
  project: Project;
  members: Member[];
  agents: Agent[];
  own: Agent[];
  arrived: boolean;
  onEdit: (edit: TicketEdit) => void;
}) {
  const to = useAddresses();
  return (
    <ContextMenu label={`${ticket.key} ${ticket.title}`} content={<CardMenu ticket={ticket} project={project} own={own} onEdit={onEdit} />}>
      <div
        className={`card${arrived ? " arrived" : ""}`}
        draggable
        onDragStart={(event: DragEvent<HTMLDivElement>) => {
          event.dataTransfer.setData(ticketDrag, ticket.id);
          event.dataTransfer.effectAllowed = "move";
        }}
      >
        <Link to={to.ticket(ticket)} className="card-link" draggable={false}>
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
        <BlockedChip ticket={ticket} />
      </div>
    </ContextMenu>
  );
}

/** Done and Canceled columns start collapsed. */
const collapsible = (status: Status) => status.kind === "done" || status.kind === "canceled";

const ticketCount = (count: number) => `${count} Ticket${count === 1 ? "" : "s"}`;

function Board({
  project,
  members,
  agents,
  user,
  tickets,
  onChanged,
}: {
  project: Project;
  members: Member[];
  agents: Agent[];
  user: User;
  tickets: TicketSummary[];
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  // Opened collapsed columns, until the User leaves the page; nothing is stored.
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const arrived = useArrivals(tickets.map((t) => `${t.id} ${t.statusId}`));
  const edge = useEdgeScroll();

  const own = agents.filter((agent) => agent.owner.id === user.id);

  /** A drop's or a card menu's change, saved at once; a refusal says why above the board. */
  const edit = async (ticketId: string, change: TicketEdit) => {
    setError(null);
    try {
      await api.editTicket(ticketId, change);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    onChanged();
  };

  const drop = async (event: DragEvent<HTMLElement>, status: Status) => {
    event.preventDefault();
    setTarget(null);
    const ticketId = event.dataTransfer.getData(ticketDrag);
    if (!ticketId || tickets.find((t) => t.id === ticketId)?.statusId === status.id) return;
    await edit(ticketId, { statusId: status.id });
  };

  const collapsed = (status: Status) => collapsible(status) && !opened.has(status.id);
  return (
    <>
      <FormError error={error} />
      <section
        aria-label="Board"
        className="board"
        ref={edge.ref}
        onDragOver={edge.onDragOver}
        onDragLeave={edge.onDragLeave}
        onDrop={edge.stop}
        onDragEnd={edge.stop}
      >
        {project.statuses.map((status) => {
          const inStatus = tickets.filter((ticket) => ticket.statusId === status.id);
          const isCollapsed = collapsed(status);
          return (
            <section
              key={status.id}
              aria-label={status.name}
              className={`column${target === status.id ? " column-target" : ""}${isCollapsed ? " column-collapsed" : ""}`}
              onDragOver={(event) => {
                if (!carriesTicket(event)) return;
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
                {status.step && !isCollapsed && (
                  <span className="column-step">
                    <ModelLabel model={status.step.model} />
                  </span>
                )}
              </header>
              {!isCollapsed && (
                <div className="column-cards">
                  {inStatus.map((ticket) => (
                    <Card
                      key={ticket.id}
                      ticket={ticket}
                      project={project}
                      members={members}
                      agents={agents}
                      own={own}
                      arrived={arrived.has(`${ticket.id} ${ticket.statusId}`)}
                      onEdit={(change) => void edit(ticket.id, change)}
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
  const to = useAddresses();
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
                  <li key={ticket.id} className="ticket-item">
                    <Link to={to.ticket(ticket)} className="row ticket-row">
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
                    <BlockedChip ticket={ticket} />
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

/** Changes the Project's settings, one toggle at a time, with what went wrong or "Saved.". */
function useProjectEdit(project: Project, onChange: (project: Project) => void) {
  const { error, busy, saved, save } = useSave();
  const toggle = (edit: ProjectEdit) => save(async () => onChange(await api.editProject(project.id, edit)));
  return { error, busy, saved, toggle };
}

function DelegationSettings({ project, onChange }: { project: Project; onChange: (project: Project) => void }) {
  const { error, busy, saved, toggle } = useProjectEdit(project, onChange);
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
      <Saved shown={saved} />
    </Panel>
  );
}

function PullRequestAutomationSettings({ project, onChange }: { project: Project; onChange: (project: Project) => void }) {
  const { error, busy, saved, toggle } = useProjectEdit(project, onChange);
  return (
    <Panel
      title="Pull Request automation"
      id="pull-request-automation"
      description="A merged Pull Request completes the Tickets it links: Verified when a User of this Workspace merged it, otherwise Unverified. A failing check or a review requesting changes sends a Ticket in a Review Status back to the Step that opened the Pull Request. Turned off, merges and failures only update the Pull Request's state."
    >
      <label className="check">
        <input
          type="checkbox"
          checked={project.pullRequestAutomation}
          disabled={busy}
          onChange={(e) => void toggle({ pullRequestAutomation: e.target.checked })}
        />
        Merges complete their Tickets, and failures send them back
      </label>
      <FormError error={error} />
      <Saved shown={saved} />
    </Panel>
  );
}

function MergesByAgentsSettings({
  workspace,
  project,
  onChange,
}: {
  workspace: WorkspaceSummary;
  project: Project;
  onChange: (project: Project) => void;
}) {
  const { error, busy, saved, toggle } = useProjectEdit(project, onChange);
  return (
    <Panel
      title="Merges by agents"
      id="merges-by-agents"
      description="A Merge Step skips itself, passing the Ticket on by its default Outcome, unless the Ticket has Autonomous Delegation and agents may merge here. Then its Run may merge the Ticket's Pull Request, completing it as Unverified."
    >
      <label className="check">
        <input
          type="checkbox"
          checked={project.agentsMayMerge}
          disabled={busy || !workspace.isAdmin}
          onChange={(e) => void toggle({ agentsMayMerge: e.target.checked })}
        />
        Agents may merge Autonomous Delegation Tickets' Pull Requests
      </label>
      {!workspace.isAdmin && <p className="muted small">Only an Admin of this Workspace changes this.</p>}
      <FormError error={error} />
      <Saved shown={saved} />
    </Panel>
  );
}

function StatusesSettings({ project, onChange }: { project: Project; onChange: (project: Project) => void }) {
  const { error, busy, saved, save } = useSave();
  const run = (change: () => Promise<Project>) => save(async () => onChange(await change()));

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
          <Saved shown={saved} />
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
    <select {...props} className="inline-select">
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
  kind: "documents" | "glossary" | "decisions" | "artifacts";
}) {
  const [projects, setProjects] = useState<ProjectSummary[]>(project ? [project] : []);
  useEffect(() => {
    api.projects(workspace.id).then(setProjects, () => {});
  }, [workspace.id]);
  return (
    <Segmented
      label="Scope"
      items={[
        { label: "Workspace", to: addresses.knowledge(workspace, null, kind), current: project === null },
        ...projects.map((p) => ({
          label: <span className="mono">{p.key}</span>,
          to: addresses.knowledge(workspace, p.key, kind),
          current: p.id === project?.id,
        })),
      ]}
    />
  );
}

/** Crumbs leading to a Project's or the Workspace's knowledge page. */
export function knowledgeCrumbs(workspace: Workspace, project: ProjectSummary | null, page: ReactNode) {
  const home = workspaceCrumb(workspace);
  return project
    ? [home, { label: <span className="mono">{project.key}</span>, to: addresses.project(workspace, project.key) }, { label: page }]
    : [home, { label: page }];
}
