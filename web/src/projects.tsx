import { useEffect, useRef, useState, type ComponentProps, type FormEvent } from "react";
import { api, statusKinds, type Project, type ProjectSummary, type Status, type StatusKind, type Workspace } from "./api.js";
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

/** A Project of the Workspace on screen, as a board, as a list, or its settings. */
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
  const [failure, setFailure] = useState<string | null>(null);
  const otherWorkspace = useRef(onOtherWorkspace);
  otherWorkspace.current = onOtherWorkspace;

  useEffect(() => {
    api.project(projectId).then(
      // A Project of another of the User's Workspaces isn't shown under this one's name.
      (found) => {
        if (found.workspaceId === workspace.id) setProject(found);
        else if (!otherWorkspace.current?.(found.workspaceId)) setFailure("No such Project.");
      },
      (e: Error) => setFailure(e.message),
    );
  }, [projectId, workspace.id]);

  if (failure) return <p role="alert">{failure}</p>;
  if (!project) return <p>Loading…</p>;
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
      {view === "board" && <Board project={project} />}
      {view === "list" && <List project={project} />}
      {view === "settings" && <Settings project={project} onChange={setProject} />}
    </>
  );
}

function Board({ project }: { project: Project }) {
  return (
    <section aria-label="Board" className="board">
      {project.statuses.map((status) => (
        <section key={status.id} aria-label={status.name} className="lane">
          <h2>{status.name}</h2>
          <p className="muted">{kindLabel(status.kind)}</p>
        </section>
      ))}
    </section>
  );
}

function List({ project }: { project: Project }) {
  return (
    <section aria-label="List" className="list">
      <p>No Tickets yet.</p>
      {project.statuses.map((status) => (
        <section key={status.id} aria-label={status.name}>
          <h2>{status.name}</h2>
          <span className="muted">0</span>
        </section>
      ))}
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
