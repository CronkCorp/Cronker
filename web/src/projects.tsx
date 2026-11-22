import { addresses, useAddresses } from "./addresses.js";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ComponentProps, type DragEvent, type FormEvent, type ReactNode } from "react";
import {
  api,
  nameOf,
  priorities,
  statusKinds,
  type Agent,
  type Member,
  type Priority,
  type Project,
  type ProjectAccess,
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
import { keyBelongsElsewhere } from "./keys.js";
import { Link, navigate } from "./router.js";
import { keepGroupSubTickets, storedGroupSubTickets } from "./storage.js";
import { ProjectArtifacts } from "./artifacts.js";
import { ProjectDecisions } from "./decisions.js";
import { ProjectDocuments } from "./documents.js";
import { ProjectGlossary } from "./terms.js";
import { RepositoriesSettings } from "./repositories.js";
import { BriefPreview, StepsSettings } from "./steps.js";
import { SettingsLayout } from "./ui/settings.js";
import { Actor, Avatar } from "./ui/actor.js";
import { Actions, Button, buttonClass, EmptyState, Field, FormError, LiveIndicator, PageHead, Panel, Saved, Segmented, workspaceCrumb } from "./ui/controls.js";
import { Chip, Key, ModelLabel, PriorityTag, RunState, StatusDot, StatusPill } from "./ui/labels.js";
import {
  ConfirmDialog,
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
import { FilterPicker } from "./ui/picker.js";
import { ReadOnlyNote } from "./write-access.js";

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
  const [group, setGroup] = useState(storedGroupSubTickets);
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
  /**
   * Shows a Ticket the board just edited as the edit answered, then fetches the Tickets again. Fetching again starts
   * after the edit, so whatever was fetched before it is dropped rather than shown over it; and the card moves without
   * waiting on that fetch, which the events the edit sets off may start again and again on a busy server.
   */
  const ticketEdited = (edited?: TicketSummary) => {
    if (edited) setTickets((shown) => shown?.map((ticket) => (ticket.id === edited.id ? edited : ticket)) ?? shown);
    loadTickets();
  };

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
        <ReadOnlyNote access={project.access} />
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
              id: "access",
              label: "Access",
              children: <AccessSettings workspace={workspace} project={project} members={members} onChange={loadProject} />,
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
            {
              id: "reports",
              label: "Reports",
              children: <ReportsSettings project={project} onChange={setProject} />,
            },
            // With Read, the settings show only the User's own Access: nothing else here is theirs to change.
          ].filter((section) => project.access === "write" || section.id === "access")}
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
            {view === "board" && (
              <button
                type="button"
                className="toggle-button"
                aria-pressed={group}
                title="Fold Sub-Tickets into their parent's card"
                onClick={() => {
                  keepGroupSubTickets(!group);
                  setGroup(!group);
                }}
              >
                Group Sub-Tickets
              </button>
            )}
          </>
        }
        actions={
          <>
            <ProjectMenu project={project} />
            {project.access === "write" && <NewTicket project={project} onCreated={loadTickets} />}
          </>
        }
      />
      <ReadOnlyNote access={project.access} />
      <Filters project={project} members={members} filter={filter} onChange={setFilter} />
      {view === "board" && (
        <Board project={project} members={members} agents={agents} user={user} tickets={tickets} group={group} onChanged={ticketEdited} />
      )}
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
      <FilterPicker
        label="Status"
        anyLabel="Any Status"
        options={project.statuses.map((s) => ({ value: s.id, label: s.name, content: <StatusPill kind={s.kind} name={s.name} /> }))}
        value={filter.statusId}
        onChange={(statusId) => set({ statusId })}
      />
      <FilterPicker
        label="Assignee"
        anyLabel="Anyone"
        options={[
          { value: "none", label: "Nobody" },
          ...members.map(({ user }) => ({ value: user.id, label: nameOf(user), content: <Actor actor={{ kind: "user", name: nameOf(user) }} /> })),
        ]}
        value={filter.assigneeId}
        onChange={(assigneeId) => set({ assigneeId })}
      />
      <FilterPicker
        label="Priority"
        anyLabel="Any Priority"
        options={priorities.map(({ priority, label }) => ({
          value: priority,
          label,
          content: priority === "none" ? undefined : <PriorityTag priority={priority} />,
        }))}
        value={filter.priority}
        onChange={(priority) => set({ priority: priority as Priority | undefined })}
      />
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
 * A blocked Ticket's chip on its card or row: *Blocked by N*, counting its unfinished blockers, those the User can't
 * read included. Hovering or focusing it names them, each a link to its Ticket, and lists each unreadable one as "a
 * Ticket you can't see". An unblocked Ticket shows nothing.
 */
function BlockedChip({ ticket }: { ticket: TicketSummary }) {
  const to = useAddresses();
  const blockers = ticket.blockedBy;
  const hidden = Array.from({ length: ticket.blockedByHidden }, (_, i) => i);
  const count = blockers.length + hidden.length;
  if (count === 0) return null;
  const named = [...blockers.map((b) => `${b.key} ${b.title}`), ...hidden.map(() => "a Ticket you can't see")];
  return (
    <HoverPopover
      label={`Tickets blocking ${ticket.key}`}
      button={{
        className: "chip chip-blocked",
        "aria-label": `Blocked by ${count}: ${named.join(", ")}`,
        children: (
          <>
            <svg className="chip-icon" viewBox="0 0 12 12" aria-hidden="true">
              <circle cx="6" cy="6" r="4.75" />
              <path d="M2.7 9.3 9.3 2.7" />
            </svg>
            Blocked by {count}
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
        {hidden.map((i) => (
          <li key={`hidden-${i}`} className="muted">
            a Ticket you can't see
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
 * On a card of a selection of several, it offers only Move to, for the whole selection, through `onMoveSelection`.
 */
function CardMenu({
  ticket,
  project,
  own,
  selection,
  onEdit,
  onMoveSelection,
}: {
  ticket: TicketSummary;
  project: Project;
  /** The signed-in User's own Agents, the only ones they delegate to. */
  own: Agent[];
  /** How many Tickets are selected, this one among them; 0 when it isn't selected. */
  selection: number;
  onEdit: (edit: TicketEdit) => void;
  onMoveSelection: (statusId: string) => void;
}) {
  if (selection > 1) {
    return (
      <MenuSub label={`Move ${ticketCount(selection)} to`}>
        {/* A mixed selection has no one current Status, so none is checked. */}
        <MenuRadioGroup label="Statuses" value="" onChange={onMoveSelection}>
          {project.statuses.map((status) => (
            <MenuRadioItem key={status.id} value={status.id}>
              <StatusPill kind={status.kind} name={status.name} model={status.step?.model} />
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuSub>
    );
  }
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
 * which holds links of its own and so sits beside the card's link rather than in it. Pressing anywhere on it and
 * moving drags it, the link included: the card is the only drag source in it, so the drag is the same wherever it
 * starts, and its text is never selected; a click on the link still opens the Ticket.
 * Ctrl/Cmd+click or Space on its focused link adds it to the board's selection or takes it out; Shift+click or
 * Shift+Space selects the range to it in its column. Right-clicking it, long-pressing it or ContextMenu / Shift+F10
 * on its focused link opens its CardMenu.
 */
function Card({
  ticket,
  project,
  members,
  agents,
  own,
  arrived,
  folded,
  selection,
  onEdit,
  onSelect,
  onMoveSelection,
}: {
  ticket: TicketSummary;
  project: Project;
  members: Member[];
  agents: Agent[];
  own: Agent[];
  arrived: boolean;
  /** With Group Sub-Tickets on, the Sub-Tickets folded into their parents; none otherwise. */
  folded: Folded;
  /** How many Tickets are selected, this one among them; 0 when it isn't selected. */
  selection: number;
  onEdit: (edit: TicketEdit) => void;
  onSelect: (range: boolean) => void;
  onMoveSelection: (statusId: string) => void;
}) {
  const to = useAddresses();
  // With Read, a card neither drags, selects nor opens a context menu of changes: it is only a link to its Ticket.
  const canWrite = project.access === "write";
  const selected = selection > 0;
  const card = (
    <div
      className={`card${arrived ? " arrived" : ""}${selected ? " card-selected" : ""}${canWrite ? "" : " card-read-only"}`}
      data-selected={selected || undefined}
      draggable={canWrite}
      onClick={(event) => {
        if (!canWrite) return;
        // The Blocked chip's and the Sub-Tickets' own links open as links do.
        if ((event.target as HTMLElement).closest(".chip-blocked, .card-sub-tickets")) return;
        const toggle = event.ctrlKey || event.metaKey;
        if (!toggle && !event.shiftKey) return;
        // Selecting, not opening the Ticket in a new tab or window.
        event.preventDefault();
        onSelect(!toggle);
      }}
      onKeyDown={(event) => {
        if (!canWrite || event.key !== " " || !(event.target as HTMLElement).closest(".card-link")) return;
        event.preventDefault();
        onSelect(event.shiftKey);
      }}
      onDragStart={(event: DragEvent<HTMLDivElement>) => {
        if (!canWrite) return event.preventDefault();
        // Show the whole card under the pointer, held where it was pressed.
        const card = event.currentTarget.getBoundingClientRect();
        event.dataTransfer.setDragImage(event.currentTarget, event.clientX - card.left, event.clientY - card.top);
        event.dataTransfer.setData(ticketDrag, ticket.id);
        event.dataTransfer.effectAllowed = "move";
      }}
    >
      {/* Explicitly draggable, as an element rather than as a link: its dragstart bubbles to the card's handler,
          which sets the card's data and image, so the drag is the card's wherever it starts (and, with Read, is
          cancelled there). Not draggable={false}: Vivaldi (and Opera) take that as "this link's text is always
          selectable", ignore user-select on it and select the card's text instead of dragging it; draggable="true"
          is their documented way to say "always drag". */}
      <Link to={to.ticket(ticket)} className="card-link" draggable>
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
        {selected && <span className="sr-only">, selected</span>}
      </Link>
      <BlockedChip ticket={ticket} />
      <SubTickets ticket={ticket} statusId={ticket.statusId} project={project} folded={folded} />
    </div>
  );
  if (!canWrite) return card;
  return (
    <ContextMenu
      label={`${ticket.key} ${ticket.title}`}
      content={
        <CardMenu ticket={ticket} project={project} own={own} selection={selection} onEdit={onEdit} onMoveSelection={onMoveSelection} />
      }
    >
      {card}
    </ContextMenu>
  );
}

/**
 * With Group Sub-Tickets on, how the board's Tickets fold: each Ticket's Sub-Tickets in one Status column, by
 * `foldKey(parentId, statusId)`; the Tickets folded away, which get no card of their own; and, by Status, the
 * parents that get a copy of their card in that column, for the Sub-Tickets there whose parent's card is in another.
 */
type Folded = { children: Map<string, TicketSummary[]>; hidden: Set<string>; copies: Map<string, Set<string>> };
const noneFolded: Folded = { children: new Map(), hidden: new Set(), copies: new Map() };
const foldKey = (parentId: string, statusId: string) => `${parentId} ${statusId}`;
/** A card's Sub-Tickets folded into it in the column it's shown in. */
const foldedInto = (folded: Folded, parentId: string, statusId: string) => folded.children.get(foldKey(parentId, statusId));

/**
 * Group Sub-Tickets: a Ticket whose parent is loaded folds under its parent in its own Status column: into the
 * parent's card when the parent is in the same column, otherwise into a copy of the parent's card there, so every
 * Sub-Ticket stays in the column of its Status. One whose parent isn't loaded, such as one a filter leaves out, keeps
 * its own card. A Sub-Ticket's own Sub-Tickets in its column fold into it, and so show nested under it when the card
 * it folds into unfolds.
 */
function foldSubTickets(tickets: TicketSummary[]): Folded {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const folded: Folded = { children: new Map(), hidden: new Set(), copies: new Map() };
  for (const ticket of tickets) {
    const parent = ticket.parentId === null ? undefined : byId.get(ticket.parentId);
    if (!parent) continue;
    folded.hidden.add(ticket.id);
    const key = foldKey(parent.id, ticket.statusId);
    folded.children.set(key, [...(folded.children.get(key) ?? []), ticket]);
    if (parent.statusId !== ticket.statusId) {
      folded.copies.set(ticket.statusId, (folded.copies.get(ticket.statusId) ?? new Set()).add(parent.id));
    }
  }
  return folded;
}

/**
 * Group Sub-Tickets: a copy of a parent's card in another column than its own, holding the parent's Sub-Tickets of
 * that column. Muted and dashed, it says which Status the parent is in; it is only a link to the parent with its
 * Sub-Tickets chip, so it neither drags, selects nor opens a context menu: the parent moves by its own card.
 */
function CardCopy({ ticket, statusId, project, folded }: { ticket: TicketSummary; statusId: string; project: Project; folded: Folded }) {
  const to = useAddresses();
  const status = project.statuses.find((s) => s.id === ticket.statusId);
  return (
    <div className="card card-copy" onDragStart={(event) => event.preventDefault()}>
      <Link to={to.ticket(ticket)} className="card-link" draggable={false}>
        <span className="ticket-key card-key">{ticket.key}</span> <span className="card-title">{ticket.title}</span>
        <span className="card-meta card-copy-status">
          {status && <StatusDot kind={status.kind} />} In {status?.name ?? "another Status"}
        </span>
      </Link>
      <SubTickets ticket={ticket} statusId={statusId} project={project} folded={folded} />
    </div>
  );
}

/**
 * A card's folded Sub-Tickets, those in the column it's shown in: *3 / 8 Sub-Tickets*, counting its direct ones and
 * those of them finished (in a Done or Canceled Status, Unverified included). It unfolds a list on the card, each by
 * Status dot, key and title, a link to its Ticket. Like the Blocked chip it holds links of its own, so it sits beside
 * the card's link. Which cards are unfolded isn't stored.
 */
function SubTickets({ ticket, statusId, project, folded }: { ticket: TicketSummary; statusId: string; project: Project; folded: Folded }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const subTickets = foldedInto(folded, ticket.id, statusId);
  if (!subTickets) return null;
  const kindOf = (statusId: string) => project.statuses.find((status) => status.id === statusId)?.kind ?? "backlog";
  const finished = subTickets.filter((sub) => ["done", "canceled"].includes(kindOf(sub.statusId))).length;
  return (
    <div className="card-sub-tickets">
      <button type="button" className="chip chip-sub-tickets" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>
        <svg className="chip-icon" viewBox="0 0 12 12" aria-hidden="true">
          <path d={open ? "M2.5 4.5 6 8l3.5-3.5" : "M4.5 2.5 8 6l-3.5 3.5"} />
        </svg>
        {finished} / {subTickets.length} Sub-Ticket{subTickets.length === 1 ? "" : "s"}
      </button>
      {open && <SubTicketList id={listId} subTickets={subTickets} kindOf={kindOf} folded={folded} />}
    </div>
  );
}

/** Unfolded Sub-Tickets, each with its own folded ones of the same column nested under it. */
function SubTicketList({
  id,
  subTickets,
  kindOf,
  folded,
}: {
  id?: string;
  subTickets: TicketSummary[];
  kindOf: (statusId: string) => StatusKind;
  folded: Folded;
}) {
  const to = useAddresses();
  return (
    <ul id={id} className="sub-ticket-list" aria-label="Sub-Tickets">
      {subTickets.map((sub) => {
        const nested = foldedInto(folded, sub.id, sub.statusId);
        return (
          <li key={sub.id}>
            <Link to={to.ticket(sub)} className="ticket-link" draggable>
              <StatusDot kind={kindOf(sub.statusId)} /> <Key>{sub.key}</Key> {sub.title}
            </Link>
            {nested && <SubTicketList subTickets={nested} kindOf={kindOf} folded={folded} />}
          </li>
        );
      })}
    </ul>
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
  group,
  onChanged,
}: {
  project: Project;
  members: Member[];
  agents: Agent[];
  user: User;
  tickets: TicketSummary[];
  /** Group Sub-Tickets: fold Sub-Tickets into their parent's card. */
  group: boolean;
  /** After a change from the board, with the Ticket as it answered; nothing when it was refused or a selection moved. */
  onChanged: (edited?: TicketSummary) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [refusals, setRefusals] = useState<{ total: number; refused: { key: string; message: string }[] } | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  // The selected Tickets' ids, and the one a range is selected from.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  // Opened collapsed columns, until the User leaves the page; nothing is stored.
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const arrived = useArrivals(tickets.map((t) => `${t.id} ${t.statusId}`));
  const edge = useEdgeScroll();

  const own = agents.filter((agent) => agent.owner.id === user.id);
  // With Group Sub-Tickets on, a Ticket folded under its parent gets no card of its own.
  const folded = useMemo(() => (group ? foldSubTickets(tickets) : null), [group, tickets]);
  const carded = useMemo(() => (folded ? tickets.filter((ticket) => !folded.hidden.has(ticket.id)) : tickets), [folded, tickets]);

  // A Ticket that leaves the board, moved away by someone else, filtered out, folded into its parent or deleted,
  // leaves the selection.
  useEffect(() => {
    setSelected((current) => {
      const shown = new Set(carded.map((t) => t.id));
      return [...current].every((id) => shown.has(id)) ? current : new Set([...current].filter((id) => shown.has(id)));
    });
  }, [carded]);

  // Escape clears the selection, unless it belongs to a field, a dialog or an open menu, which close first.
  useEffect(() => {
    if (selected.size === 0) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || keyBelongsElsewhere(event)) return;
      if (document.querySelector("[role=menu]")) return;
      setSelected(new Set());
      setAnchor(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selected.size]);

  /**
   * Selects or unselects a card: toggling it, or, for a range, selecting every card from the anchor to it in its
   * column, as shown. A range from a card of another column, or with no anchor, selects just this one.
   */
  const select = (ticket: TicketSummary, range: boolean) => {
    const from = range ? carded.find((t) => t.id === anchor) : undefined;
    const next = new Set(selected);
    if (from && from.statusId === ticket.statusId) {
      const column = carded.filter((t) => t.statusId === ticket.statusId);
      const [i, j] = [column.indexOf(from), column.indexOf(ticket)];
      for (const t of column.slice(Math.min(i, j), Math.max(i, j) + 1)) next.add(t.id);
    } else if (range || !next.has(ticket.id)) {
      next.add(ticket.id);
      setAnchor(ticket.id);
    } else {
      next.delete(ticket.id);
      setAnchor(ticket.id);
    }
    setSelected(next);
  };

  /** A drop's or a card menu's change, saved at once; a refusal says why above the board. */
  const edit = async (ticketId: string, change: TicketEdit) => {
    setError(null);
    setRefusals(null);
    let edited: TicketSummary | undefined;
    try {
      edited = await api.editTicket(ticketId, change);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    onChanged(edited);
  };

  /**
   * Moves every selected Ticket to the Status, one at a time, each saved as if moved alone, so each is its own Change
   * and starts Runs as usual. A refused one doesn't stop the rest; the refusals are listed above the board, and those
   * Tickets stay selected while the moved ones leave the selection.
   */
  const moveSelection = async (statusId: string) => {
    setError(null);
    setRefusals(null);
    const moving = tickets.filter((t) => selected.has(t.id) && t.statusId !== statusId);
    const refused: { key: string; message: string }[] = [];
    const moved = new Set<string>();
    for (const ticket of moving) {
      try {
        await api.editTicket(ticket.id, { statusId });
        moved.add(ticket.id);
      } catch (e) {
        refused.push({ key: ticket.key, message: e instanceof Error ? e.message : String(e) });
      }
    }
    if (refused.length > 0) setRefusals({ total: moving.length, refused });
    setSelected((current) => new Set([...current].filter((id) => !moved.has(id))));
    onChanged();
  };

  const drop = async (event: DragEvent<HTMLElement>, status: Status) => {
    event.preventDefault();
    setTarget(null);
    const ticketId = event.dataTransfer.getData(ticketDrag);
    if (!ticketId) return;
    // A selected card carries the whole selection with it; any other card moves alone.
    if (selected.has(ticketId)) return moveSelection(status.id);
    if (tickets.find((t) => t.id === ticketId)?.statusId === status.id) return;
    await edit(ticketId, { statusId: status.id });
  };

  const collapsed = (status: Status) => collapsible(status) && !opened.has(status.id);
  return (
    <>
      <FormError error={error} />
      {refusals && (
        <div role="alert" className="form-error board-refusals">
          <p>
            {refusals.refused.length} of {ticketCount(refusals.total)} not moved:
          </p>
          <ul>
            {refusals.refused.map((r) => (
              <li key={r.key}>
                <span className="ticket-key">{r.key}</span>: {r.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div role="status" className="board-selection">
        {selected.size > 0 && (
          <>
            <span>{selected.size} selected</span>
            <Button
              variant="ghost"
              onClick={() => {
                setSelected(new Set());
                setAnchor(null);
              }}
            >
              Clear
            </Button>
          </>
        )}
      </div>
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
          const inStatus = carded.filter((ticket) => ticket.statusId === status.id);
          // Copies of parents whose card is in another column, for their Sub-Tickets in this one, in the board's order.
          const copied = folded?.copies.get(status.id);
          const copies = copied ? tickets.filter((ticket) => copied.has(ticket.id)) : [];
          const shown = inStatus.length + copies.length;
          const isCollapsed = collapsed(status);
          return (
            <section
              key={status.id}
              aria-label={status.name}
              className={`column${target === status.id ? " column-target" : ""}${isCollapsed ? " column-collapsed" : ""}`}
              onDragOver={(event) => {
                if (project.access !== "write" || !carriesTicket(event)) return;
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
                    aria-label={`${status.name}, ${ticketCount(shown)}`}
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
                    <span className="column-count">{shown}</span>
                  </button>
                ) : (
                  <StatusDot kind={status.kind} />
                )}
                <h2 className={isCollapsed ? "sr-only" : "column-name"} title={status.name}>
                  {status.name}
                </h2>
                {!collapsible(status) && <span className="column-count">{shown}</span>}
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
                      folded={folded ?? noneFolded}
                      selection={selected.has(ticket.id) ? selected.size : 0}
                      onEdit={(change) => void edit(ticket.id, change)}
                      onSelect={(range) => select(ticket, range)}
                      onMoveSelection={(statusId) => void moveSelection(statusId)}
                    />
                  ))}
                  {copies.map((parent) => (
                    <CardCopy key={`copy-${parent.id}`} ticket={parent} statusId={status.id} project={project} folded={folded ?? noneFolded} />
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

function ReportsSettings({ project, onChange }: { project: Project; onChange: (project: Project) => void }) {
  const { error, busy, saved, toggle } = useProjectEdit(project, onChange);
  return (
    <Panel
      title="Reports"
      id="reports"
      description="With concise Reports on, every Brief in this Project tells its Run to keep its Reports short: the outcome, the findings, what it verified and what the next Run or User needs, without the working. The Brief preview shows the rule. Nothing stored is cut."
    >
      <label className="check">
        <input
          type="checkbox"
          checked={project.conciseReports}
          disabled={busy}
          onChange={(e) => void toggle({ conciseReports: e.target.checked })}
        />
        Runs keep their Reports concise
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

type Level = ProjectAccess["users"][number]["level"];

/**
 * Who may see the Project: open to every User of the Workspace, or private to the Users listed here and the
 * Admins, who keep Write in every Project. Only an Admin reads and changes it; others see whether it is private and
 * their own Access.
 */
function AccessSettings({
  workspace,
  project,
  members,
  onChange,
}: {
  workspace: WorkspaceSummary;
  project: Project;
  members: Member[];
  onChange: () => void;
}) {
  const { error, busy, saved, save, clear } = useSave();
  const [access, setAccess] = useState<ProjectAccess | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState<{ access: ProjectAccess; tickets: number } | null>(null);
  useEffect(() => {
    if (!workspace.isAdmin) return;
    api.projectAccess(project.id).then(setAccess, (e: Error) => setFailure(e.message));
  }, [workspace.isAdmin, project.id]);
  const description =
    "An open Project is for every User of the Workspace. A private one is only for the Users listed here and the Workspace's Admins, who always have Write; to anyone else, and their Agents, it doesn't exist. A User listed with Read reads everything in it but changes nothing.";
  if (!workspace.isAdmin) {
    return (
      <Panel title="Access" id="access" description={description}>
        <p>
          This Project is {project.visibility}, and you have {project.access === "write" ? "Write" : "Read"} in it
          {project.access === "read" ? ": you read everything in it, but change nothing." : "."}
        </p>
        <p className="muted small">Only an Admin of this Workspace changes this.</p>
      </Panel>
    );
  }
  if (failure) return <FormError error={failure} />;
  if (!access) return <p className="muted">Loading…</p>;
  const listed = new Set(access.users.map((u) => u.userId));
  const commit = async (next: ProjectAccess) => {
    setAccess(await api.setProjectAccess(project.id, next));
    onChange();
  };
  // A change that takes Users' Write, and so their Tickets here, asks first; one that affects no Ticket saves at once.
  const apply = async (next: ProjectAccess) => {
    let asked = false;
    await save(async () => {
      const { tickets } = await api.previewProjectAccess(project.id, next);
      asked = tickets > 0;
      if (asked) setPending({ access: next, tickets });
      else await commit(next);
    });
    if (asked) clear();
  };
  const toggle = (userId: string, on: boolean) =>
    void apply({
      ...access,
      users: on ? [...access.users, { userId, level: "write" }] : access.users.filter((u) => u.userId !== userId),
    });
  const levelOf = (userId: string) => access.users.find((u) => u.userId === userId)?.level;
  const setLevel = (userId: string, level: Level) =>
    void apply({ ...access, users: access.users.map((u) => (u.userId === userId ? { ...u, level } : u)) });
  return (
    <Panel title="Access" id="access" description={description}>
      <fieldset className="access-visibility">
        <legend>Visibility</legend>
        {(["open", "private"] as const).map((visibility) => (
          <label key={visibility} className="check">
            <input
              type="radio"
              name="visibility"
              value={visibility}
              checked={access.visibility === visibility}
              disabled={busy}
              onChange={() => void apply({ ...access, visibility })}
            />
            {visibility === "open" ? "Open to every User of the Workspace" : "Private to the Users listed below"}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Listed Users</legend>
        {members.map(({ user, isAdmin }) => (
          <div key={user.id} className="access-user">
            <label className="check">
              <input
                type="checkbox"
                checked={isAdmin || listed.has(user.id)}
                disabled={busy || isAdmin}
                onChange={(e) => toggle(user.id, e.target.checked)}
              />
              {nameOf(user)}
            </label>
            {isAdmin ? (
              <span className="muted small">Admin, always Write</span>
            ) : (
              listed.has(user.id) && (
                <select
                  aria-label={`Access of ${nameOf(user)}`}
                  value={levelOf(user.id)}
                  disabled={busy}
                  onChange={(e) => setLevel(user.id, e.target.value as Level)}
                >
                  <option value="write">Write</option>
                  <option value="read">Read</option>
                </select>
              )
            )}
          </div>
        ))}
      </fieldset>
      <FormError error={error} />
      <Saved shown={saved} />
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title="Change Access?"
        confirm="Change Access"
        onConfirm={async () => {
          await commit(pending!.access);
          setPending(null);
        }}
      >
        {pending &&
          `This takes Write in ${project.key} from Users who have it now, so ${pending.tickets} ${
            pending.tickets === 1 ? "Ticket" : "Tickets"
          } will be unassigned or undelegated, stopping their running Runs. They wait in the Admins' Inbox to be assigned again.`}
      </ConfirmDialog>
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

/**
 * The Workspace / Project scope dropdown of a knowledge page's head. Its button shows the current scope; its menu lists
 * the Workspace, then the Projects by key, the current one checked. Choosing one goes to that scope's page, as a link would.
 */
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
  const current = project?.key ?? "";
  const byKey = [...projects].sort((a, b) => a.key.localeCompare(b.key));
  return (
    <Menu
      label="Scope"
      align="start"
      trigger={
        <button
          type="button"
          className={`${buttonClass("secondary")} scope-switch`}
          aria-label={`Scope: ${project ? `${project.key} ${project.name}` : "Workspace"}`}
        >
          <span className="scope-switch-name">
            {project ? (
              <>
                <span className="mono">{project.key}</span> {project.name}
              </>
            ) : (
              "Workspace"
            )}
          </span>
          <span className="scope-switch-caret" aria-hidden="true">
            ▾
          </span>
        </button>
      }
    >
      <MenuRadioGroup
        label="Scope"
        value={current}
        onChange={(key) => key !== current && navigate(addresses.knowledge(workspace, key || null, kind))}
      >
        <MenuRadioItem value="">Workspace</MenuRadioItem>
        {byKey.map((p) => (
          <MenuRadioItem key={p.id} value={p.key}>
            <span className="mono">{p.key}</span> {p.name}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </Menu>
  );
}

/** Crumbs leading to a Project's or the Workspace's knowledge page. */
export function knowledgeCrumbs(workspace: Workspace, project: ProjectSummary | null, page: ReactNode) {
  const home = workspaceCrumb(workspace);
  return project
    ? [home, { label: <span className="mono">{project.key}</span>, to: addresses.project(workspace, project.key) }, { label: page }]
    : [home, { label: page }];
}
