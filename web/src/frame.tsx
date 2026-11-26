import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { api, nameOf, type ProjectSummary, type User, type WorkspaceSummary } from "./api.js";
import { AddressContext, addresses, useAddresses } from "./addresses.js";
import { InboxLink, useInbox } from "./inbox.js";
import { knowledgeCounts } from "./knowledge-counts.js";
import { keyBelongsElsewhere } from "./keys.js";
import { useLatest, useLiveEvents } from "./live.js";
import { Link, navigate } from "./router.js";
import { SearchBox } from "./search.js";
import { Avatar } from "./ui/actor.js";
import { keepActiveProject, keepSidebarHidden, storedActiveProject, storedSidebarHidden } from "./storage.js";
import { Menu, MenuItem, MenuLabel, MenuLink, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuSub } from "./ui/overlays.js";

/** Which item of the sidebar a page belongs to. */
export type Area =
  | "inbox"
  | "documents"
  | "terms"
  | "decisions"
  | "artifacts"
  | "project"
  | "agents"
  | "runners"
  | "members"
  | "github"
  | "settings"
  | null;

/** What the page on screen tells the frame: its sidebar item, and the Project it is in, if any. */
interface Place {
  area: Area;
  projectId: string | null;
}

const PlaceContext = createContext<(place: Place) => void>(() => {});

/**
 * Tells the sidebar where the page is: its item, and the Project, which becomes the active one whose Tickets,
 * Documents, Terms, Decisions and Artifacts the sidebar leads to. A Ticket marks Tickets; a Document marks Documents.
 */
export function usePlace(area: Area, projectId: string | null = null): void {
  const set = useContext(PlaceContext);
  useEffect(() => set({ area, projectId }), [set, area, projectId]);
}

/** The signed-in frame: the sidebar and the main column every signed-in page renders in. */
export function Frame({
  user,
  workspaces,
  current,
  onSignOut,
  children,
}: {
  user: User;
  workspaces: WorkspaceSummary[];
  current: WorkspaceSummary | undefined;
  onSignOut: () => Promise<void>;
  children: ReactNode;
}) {
  const [place, setPlace] = useState<Place>({ area: null, projectId: null });
  const set = useCallback((next: Place) => {
    setPlace((shown) => (shown.area === next.area && shown.projectId === next.projectId ? shown : next));
  }, []);
  const sidebar = useSidebarHiding();
  const projects = useProjects(current?.id ?? null);
  const activeProject = useActiveProjectOf(current?.id ?? null, projects, place.projectId);
  const book = useMemo(
    () => ({ workspace: current ?? null, projects, projectId: place.projectId, activeProject }),
    [current, projects, place.projectId, activeProject],
  );
  return (
    <AddressContext.Provider value={book}>
      <PlaceContext.Provider value={set}>
        <div className={`frame${sidebar.hidden ? " frame-sidebar-hidden" : ""}`}>
          <Sidebar
            user={user}
            workspaces={workspaces}
            current={current}
            projects={projects}
            activeProject={activeProject}
            place={place}
            onSignOut={onSignOut}
            hideToggle={<SidebarToggle sidebarHidden={false} buttonRef={sidebar.hideButton} onToggle={sidebar.toggle} />}
          />
          <main className="main">
            {sidebar.hidden && <SidebarToggle sidebarHidden buttonRef={sidebar.showButton} onToggle={sidebar.toggle} />}
            <div className="main-inner">{children}</div>
          </main>
        </div>
      </PlaceContext.Provider>
    </AddressContext.Provider>
  );
}

/**
 * The active Project: the page's, else the one last active in the Workspace on this browser while it is still among
 * the User's Projects, else the first unarchived one by key. A page reporting a Project makes it the one remembered.
 * Null while the Projects load, and in a Workspace with none.
 */
function useActiveProjectOf(
  workspaceId: string | null,
  projects: ProjectSummary[] | null,
  pageProjectId: string | null,
): ProjectSummary | null {
  // Only the Workspace's own: the list of the Workspace left behind lingers until the new one loads.
  const own = useMemo(
    () => (workspaceId === null ? null : (projects?.filter((p) => p.workspaceId === workspaceId) ?? null)),
    [workspaceId, projects],
  );
  const pageProject = own?.find((p) => p.id === pageProjectId) ?? null;
  useEffect(() => {
    if (workspaceId !== null && pageProject) keepActiveProject(workspaceId, pageProject.id);
  }, [workspaceId, pageProject]);
  return useMemo(() => {
    if (workspaceId === null || own === null) return null;
    return pageProject ?? landingProject(workspaceId, own);
  }, [workspaceId, own, pageProject]);
}

/**
 * The Project a Workspace opens on when no page names one: the one last active there on this browser while it is
 * still among its Projects, else the first unarchived one by key, else none.
 */
export function landingProject(workspaceId: string, projects: ProjectSummary[]): ProjectSummary | null {
  const remembered = storedActiveProject(workspaceId);
  return (
    projects.find((p) => p.id === remembered) ??
    projects.filter((p) => p.archivedAt === null).sort((a, b) => a.key.localeCompare(b.key))[0] ??
    null
  );
}

/** Where opening a Workspace leads: its active Project's Tickets, in the remembered view, or its Projects overview when it has no Project. */
export async function workspaceLanding(workspace: WorkspaceSummary): Promise<string> {
  const projects = await api.projects(workspace.id).catch((): ProjectSummary[] => []);
  const project = landingProject(workspace.id, projects);
  return project ? addresses.tickets(workspace, project.key) : addresses.workspace(workspace);
}

/** Below this width the sidebar is a strip with a menu, which neither hides nor shows; as in `frame.css`. */
const narrowQuery = "(max-width: 760px)";

/** The sidebar's shortcut as macOS writes it, or as other systems do; either modifier works on both. */
const shortcut = /Mac|iPhone|iPad/.test(navigator.platform)
  ? { keys: "Meta+\\", label: "⌘\\" }
  : { keys: "Control+\\", label: "Ctrl+\\" };

/**
 * Whether the sidebar is hidden, kept on this browser, with `Ctrl+\` (`⌘\` on macOS) toggling it outside fields and dialogs.
 * A button that toggles it hands focus to the button that toggles it back.
 */
function useSidebarHiding() {
  const [hidden, setHidden] = useState(storedSidebarHidden);
  const hideButton = useRef<HTMLButtonElement>(null);
  const showButton = useRef<HTMLButtonElement>(null);
  const moveFocus = useRef(false);
  const toggle = useCallback((fromButton: boolean) => {
    moveFocus.current = fromButton;
    setHidden((was) => !was);
  }, []);
  useEffect(() => {
    keepSidebarHidden(hidden);
    if (!moveFocus.current) return;
    moveFocus.current = false;
    (hidden ? showButton : hideButton).current?.focus();
  }, [hidden]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key !== "\\" || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (keyBelongsElsewhere(event) || window.matchMedia(narrowQuery).matches) return;
      event.preventDefault();
      toggle(false);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [toggle]);
  return { hidden, toggle, hideButton, showButton };
}

/** The button at the top of the sidebar that hides it, or, while it is hidden, the one in the main column that shows it. */
function SidebarToggle({
  sidebarHidden,
  buttonRef,
  onToggle,
}: {
  sidebarHidden: boolean;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onToggle: (fromButton: boolean) => void;
}) {
  const label = sidebarHidden ? "Show sidebar" : "Hide sidebar";
  return (
    <button
      ref={buttonRef}
      type="button"
      className={`sidebar-toggle ${sidebarHidden ? "sidebar-show" : "sidebar-hide"}`}
      aria-label={label}
      aria-keyshortcuts={shortcut.keys}
      title={`${label} (${shortcut.label})`}
      onClick={() => onToggle(true)}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
        <path d="M6 2.75v10.5" />
      </svg>
    </button>
  );
}

function Sidebar({
  user,
  workspaces,
  current,
  projects,
  activeProject,
  place,
  onSignOut,
  hideToggle,
}: {
  user: User;
  workspaces: WorkspaceSummary[];
  current: WorkspaceSummary | undefined;
  projects: ProjectSummary[] | null;
  activeProject: ProjectSummary | null;
  place: Place;
  onSignOut: () => Promise<void>;
  hideToggle: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const to = useAddresses();
  // On a phone, following a link out of the menu closes it.
  const closing = () => setMenuOpen(false);
  const area = place.area;

  return (
    <nav aria-label="Sidebar" className={`sidebar${menuOpen ? " sidebar-open" : ""}`}>
      <div className="sidebar-strip">
        <div className="sidebar-top">
          <WorkspaceProjectSwitcher workspaces={workspaces} current={current} projects={projects} active={activeProject} />
          {hideToggle}
        </div>
        {current && (
          <>
            <SearchBox key={`search ${current.id}`} />
            <SidebarLinks key={current.id} workspaceId={current.id} activeProject={activeProject} area={area} />
          </>
        )}
        <button
          type="button"
          className="sidebar-menu-button button button-secondary button-small"
          aria-expanded={menuOpen}
          aria-controls="sidebar-more"
          onClick={() => setMenuOpen((open) => !open)}
        >
          Menu
        </button>
      </div>
      <div id="sidebar-more" className="sidebar-more" onClick={(event) => (event.target as HTMLElement).closest("a") && closing()}>
        <div className="sidebar-group">
          <h2 className="sidebar-group-label">Workspace</h2>
          {current && (
            <SideLink to={to.workspace("agents")} current={area === "agents"}>
              Agents
            </SideLink>
          )}
          <SideLink to="/runners" current={area === "runners"}>
            Runners
          </SideLink>
          {current?.isAdmin && (
            <>
              <SideLink to={to.workspace("members")} current={area === "members"}>
                Members
              </SideLink>
              <SideLink to="/github" current={area === "github"}>
                GitHub
              </SideLink>
              <SideLink to={to.workspace("settings")} current={area === "settings"}>
                Settings
              </SideLink>
            </>
          )}
        </div>
        <div className="sidebar-account">
          <Menu
            label="Account"
            align="start"
            trigger={
              <button type="button" className="sidebar-user" aria-label={nameOf(user)}>
                <Avatar actor={{ kind: "user", name: nameOf(user) }} />
                <span className="sidebar-user-name">{nameOf(user)}</span>
                {current?.isAdmin && <span className="sidebar-user-role">Admin</span>}
              </button>
            }
          >
            <MenuLink to="/account">Account settings</MenuLink>
            <MenuItem
              onSelect={() => {
                setError(null);
                onSignOut().catch((e: Error) => setError(e.message));
              }}
            >
              Sign out
            </MenuItem>
          </Menu>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
        </div>
      </div>
    </nav>
  );
}

/**
 * The Inbox and the links to the active Project's Tickets and knowledge, sharing one fetch of the Inbox: each
 * knowledge link counts the New knowledge of its kind waiting for the place it leads to.
 */
function SidebarLinks({
  workspaceId,
  activeProject,
  area,
}: {
  workspaceId: string;
  activeProject: ProjectSummary | null;
  area: Place["area"];
}) {
  const to = useAddresses();
  const { inbox } = useInbox(workspaceId);
  const counts = knowledgeCounts(inbox, activeProject?.id ?? null);
  const knowledge = (kind: "documents" | "glossary" | "decisions" | "artifacts") => to.knowledge(activeProject, kind);
  return (
    <>
      <InboxLink inbox={inbox} current={area === "inbox"} />
      {activeProject && (
        // The board, the List, a Ticket and Project settings are all the Project's Tickets' pages.
        <SideLink to={to.tickets(activeProject)} current={area === "project"}>
          Tickets
        </SideLink>
      )}
      <SideLink to={knowledge("documents")} current={area === "documents"} count={counts.document}>
        Documents
      </SideLink>
      <SideLink to={knowledge("glossary")} current={area === "terms"} count={counts.term}>
        Terms
      </SideLink>
      <SideLink to={knowledge("decisions")} current={area === "decisions"} count={counts.decision}>
        Decisions
      </SideLink>
      <SideLink to={knowledge("artifacts")} current={area === "artifacts"} count={counts.artifact}>
        Artifacts
      </SideLink>
    </>
  );
}

/** A sidebar link, with a red count of what is new there when there is some, read as part of its name. */
function SideLink({ to, current, count = 0, children }: { to: string; current: boolean; count?: number; children: string }) {
  return (
    <Link to={to} current={current} className="side-link" aria-label={count > 0 ? `${children}, ${count} new` : undefined}>
      {children}
      {count > 0 ? <span className="count">{count}</span> : null}
    </Link>
  );
}

/**
 * The Workspace and the active Project, under the Workspace's mark: its menu opens another Project's board, the
 * Projects overview or a New Project, and opens another Workspace's active Project or creates a Workspace.
 */
function WorkspaceProjectSwitcher({
  workspaces,
  current,
  projects,
  active,
}: {
  workspaces: WorkspaceSummary[];
  current: WorkspaceSummary | undefined;
  projects: ProjectSummary[] | null;
  active: ProjectSummary | null;
}) {
  const name = current?.name ?? "Cronk";
  const own = (projects ?? []).filter((p) => p.workspaceId === current?.id).sort((a, b) => a.key.localeCompare(b.key));
  const unarchived = own.filter((p) => p.archivedAt === null);
  const archived = own.filter((p) => p.archivedAt !== null);
  const openBoard = (id: string) => {
    const project = own.find((p) => p.id === id);
    if (current && project) navigate(addresses.tickets(current, project.key));
  };
  const projectItem = (p: ProjectSummary) => (
    <MenuRadioItem key={p.id} value={p.id}>
      <span className="menu-key">{p.key}</span> {p.name}
    </MenuRadioItem>
  );
  return (
    <Menu
      label="Workspace and Project"
      align="start"
      trigger={
        <button
          type="button"
          className="workspace-switcher"
          aria-label={`Workspace and Project: ${name}${active ? `, ${active.key} ${active.name}` : ""}`}
        >
          <span className="workspace-mark" aria-hidden="true">
            {name.slice(0, 1).toUpperCase()}
          </span>
          <span className="workspace-switcher-text">
            <span className="workspace-name">{name}</span>
            {active && (
              <span className="workspace-project">
                <span className="workspace-project-key">{active.key}</span> {active.name}
              </span>
            )}
          </span>
          <span className="workspace-caret" aria-hidden="true">
            ▾
          </span>
        </button>
      }
    >
      {current && (
        <>
          {unarchived.length > 0 && (
            <>
              <MenuLabel>Projects</MenuLabel>
              <MenuRadioGroup label="Projects" value={active?.id ?? ""} onChange={openBoard}>
                {unarchived.map(projectItem)}
              </MenuRadioGroup>
            </>
          )}
          {archived.length > 0 && (
            <MenuSub label="Archived">
              <MenuRadioGroup label="Archived Projects" value={active?.id ?? ""} onChange={openBoard}>
                {archived.map(projectItem)}
              </MenuRadioGroup>
            </MenuSub>
          )}
          <MenuLink to={addresses.workspace(current)}>All Projects</MenuLink>
          <MenuLink to={`${addresses.workspace(current)}#new-project`}>New Project…</MenuLink>
          <MenuSeparator />
        </>
      )}
      {workspaces.length > 0 && (
        <>
          <MenuLabel>Workspaces</MenuLabel>
          <MenuRadioGroup
            label="Workspaces"
            value={current?.id ?? ""}
            onChange={(id) => {
              const workspace = workspaces.find((w) => w.id === id);
              if (workspace) void workspaceLanding(workspace).then(navigate);
            }}
          >
            {workspaces.map((w) => (
              <MenuRadioItem key={w.id} value={w.id}>
                {w.name}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </>
      )}
      <MenuSeparator />
      <MenuLink to="/workspaces/new">New Workspace</MenuLink>
    </Menu>
  );
}

/** The Workspace's Projects, archived ones included, kept current as Projects are created, changed or archived. */
export function useProjects(workspaceId: string | null): ProjectSummary[] | null {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const latest = useLatest();
  const load = useCallback(() => {
    if (workspaceId) latest(api.projects(workspaceId), setProjects, () => setProjects([]));
  }, [workspaceId, latest]);
  useEffect(load, [load]);
  useLiveEvents(workspaceId ?? "", (event) => {
    if (event.type === "project.created" || event.type === "project.changed" || event.type === "reconnected") load();
  });
  return projects;
}

/** A signed-out page: a centred card under Cronk's mark. */
export function Centered({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="centered">
      <div className="centered-mark" aria-hidden="true">
        <span className="workspace-mark">C</span> Cronk
      </div>
      <div className="centered-card">
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}
