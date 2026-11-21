import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { api, nameOf, type ProjectSummary, type User, type WorkspaceSummary } from "./api.js";
import { AddressContext, addresses, useAddresses } from "./addresses.js";
import { InboxLink } from "./inbox.js";
import { keyBelongsElsewhere } from "./keys.js";
import { useLatest, useLiveEvents } from "./live.js";
import { Link } from "./router.js";
import { SearchBox } from "./search.js";
import { Avatar } from "./ui/actor.js";
import { chooseTheme, keepSidebarHidden, storedSidebarHidden, storedTheme, type Theme } from "./storage.js";
import { Menu, MenuChoice, MenuItem, MenuLabel, MenuLink, MenuSeparator } from "./ui/overlays.js";

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
 * Tells the sidebar where the page is: its item, and the Project whose Documents, Terms, Decisions and Artifacts the
 * sidebar then leads to. A Ticket marks its Project; a Document marks Documents.
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
  const book = useMemo(() => ({ workspace: current ?? null, projects }), [current, projects]);
  return (
    <AddressContext.Provider value={book}>
      <PlaceContext.Provider value={set}>
        <div className={`frame${sidebar.hidden ? " frame-sidebar-hidden" : ""}`}>
          <Sidebar
            user={user}
            workspaces={workspaces}
            current={current}
            projects={projects}
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
  place,
  onSignOut,
  hideToggle,
}: {
  user: User;
  workspaces: WorkspaceSummary[];
  current: WorkspaceSummary | undefined;
  projects: ProjectSummary[] | null;
  place: Place;
  onSignOut: () => Promise<void>;
  hideToggle: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState(storedTheme);
  const to = useAddresses();
  const project = projects?.find((p) => p.id === place.projectId) ?? null;
  // On a phone, following a link out of the menu closes it.
  const closing = () => setMenuOpen(false);
  const area = place.area;
  const knowledge = (kind: "documents" | "glossary" | "decisions" | "artifacts") => to.knowledge(project, kind);

  return (
    <nav aria-label="Sidebar" className={`sidebar${menuOpen ? " sidebar-open" : ""}`}>
      <div className="sidebar-strip">
        <div className="sidebar-top">
          <WorkspaceSwitcher workspaces={workspaces} current={current} />
          {hideToggle}
        </div>
        {current && (
          <>
            <SearchBox key={`search ${current.id}`} />
            <InboxLink key={current.id} workspaceId={current.id} current={area === "inbox"} />
            <SideLink to={knowledge("documents")} current={area === "documents"}>
              Documents
            </SideLink>
            <SideLink to={knowledge("glossary")} current={area === "terms"}>
              Terms
            </SideLink>
            <SideLink to={knowledge("decisions")} current={area === "decisions"}>
              Decisions
            </SideLink>
            <SideLink to={knowledge("artifacts")} current={area === "artifacts"}>
              Artifacts
            </SideLink>
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
        {current && (
          <div className="sidebar-group">
            <h2 className="sidebar-group-label">Projects</h2>
            {projects?.length === 0 && <p className="sidebar-note">None yet.</p>}
            {projects?.map((p) => (
              <SideLink key={p.id} to={to.project(p)} current={area === "project" && place.projectId === p.id}>
                <span className="sidebar-key">{p.key}</span> {p.name}
              </SideLink>
            ))}
          </div>
        )}
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
            <MenuLabel>Theme</MenuLabel>
            <MenuChoice<Theme>
              label="Theme"
              value={theme}
              options={[
                { value: "system", label: "System" },
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
              onChange={(next) => {
                chooseTheme(next);
                setTheme(next);
              }}
            />
            <MenuSeparator />
            <MenuLink to="/password">Password</MenuLink>
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

function SideLink({ to, current, children }: { to: string; current: boolean; children: ReactNode }) {
  return (
    <Link to={to} current={current} className="side-link">
      {children}
    </Link>
  );
}

/** The Workspace's name and mark, which switches Workspace or creates one. */
function WorkspaceSwitcher({ workspaces, current }: { workspaces: WorkspaceSummary[]; current: WorkspaceSummary | undefined }) {
  const name = current?.name ?? "Cronk";
  return (
    <Menu
      label="Workspace"
      align="start"
      trigger={
        <button type="button" className="workspace-switcher" aria-label={`Workspace: ${name}`}>
          <span className="workspace-mark" aria-hidden="true">
            {name.slice(0, 1).toUpperCase()}
          </span>
          <span className="workspace-name">{name}</span>
          <span className="workspace-caret" aria-hidden="true">
            ▾
          </span>
        </button>
      }
    >
      {workspaces.length > 0 && <MenuLabel>Workspaces</MenuLabel>}
      {workspaces.map((w) => (
        <MenuLink key={w.id} to={addresses.workspace(w)} current={w.id === current?.id}>
          {w.name}
        </MenuLink>
      ))}
      <MenuSeparator />
      <MenuLink to="/workspaces/new">New Workspace</MenuLink>
    </Menu>
  );
}

/** The Workspace's Projects, kept current as Projects are created. */
function useProjects(workspaceId: string | null): ProjectSummary[] | null {
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
