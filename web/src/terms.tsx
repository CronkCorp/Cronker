import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type Place, type ProjectSummary, type Term, type TermComparison, type TermVersion, type Workspace } from "./api.js";
import { DocumentBody, VersionMeta, Versions } from "./documents.js";
import { ExportLink } from "./export.js";
import { field, useSubmit } from "./forms.js";
import { usePlace } from "./frame.js";
import { Markdown } from "./markdown.js";
import { knowledgeCrumbs, ScopeSwitch } from "./projects.js";
import { Link, navigate } from "./router.js";
import { useArrivals, useDeletedElsewhere, useLatest, useLiveEvents } from "./live.js";
import { Actions, Banner, Button, DeletedElsewhere, EmptyState, Field, FormError, LiveIndicator, PageHead } from "./ui/controls.js";
import { Diff, lineDiff } from "./ui/diff.js";
import { Chip } from "./ui/labels.js";
import { ConfirmDialog, Dialog, DialogActions, DialogClose, Menu, MenuItem } from "./ui/overlays.js";

/** Where a glossary is shown: a Project's Terms page, or the Workspace's. */
const glossaryPage = (place: Place) => (place.kind === "project" ? `/projects/${place.id}/glossary` : `/workspaces/${place.id}/glossary`);

/** Words to avoid as typed: separated by commas, each trimmed, blanks dropped. */
const wordsToAvoid = (text: string) =>
  text
    .split(",")
    .map((word) => word.trim())
    .filter(Boolean);

/** "Avoid:" and the words, struck through. */
function Avoid({ words }: { words: string[] }) {
  if (words.length === 0) return null;
  return (
    <p className="avoid">
      Avoid:{" "}
      {words.map((word, index) => (
        <span key={word}>
          <s>{word}</s>
          {index < words.length - 1 && ", "}
        </span>
      ))}
    </p>
  );
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Terms as a glossary: each with its scope and Version, its definition and the words to avoid. A Project's Term that
 * replaces a Workspace Term of the same name says so, and on the Workspace's page a Term says where it is replaced.
 */
function Glossary({
  workspace,
  project,
  terms,
  workspaceTerms,
  replacedIn,
}: {
  workspace: Workspace;
  project: ProjectSummary | null;
  terms: Term[];
  /** The Workspace's own Terms, which a Project's override. */
  workspaceTerms: Term[];
  /** For the Workspace's page: each Project's own Terms, by Project. */
  replacedIn: { project: ProjectSummary; terms: Term[] }[];
}) {
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const place: Place = project ? { kind: "project", id: project.id } : { kind: "workspace", id: workspace.id };
  const typed = filter.trim().toLowerCase();
  const shown = typed
    ? terms.filter((t) => t.name.toLowerCase().includes(typed) || t.avoid.some((word) => word.toLowerCase().includes(typed)))
    : terms;
  const own = terms.filter((t) => (project ? t.projectId === project.id : true)).length;
  const arrived = useArrivals(terms.map((t) => t.id));
  return (
    <div className="page">
      <PageHead
        crumbs={knowledgeCrumbs(workspace, project, "Terms")}
        title="Terms"
        switcher={
          <>
            <LiveIndicator workspaceId={workspace.id} />
            <ScopeSwitch workspace={workspace} project={project} kind="glossary" />
          </>
        }
        actions={
          <>
            <ExportLink place={place} />
            <Button variant="primary" onClick={() => setCreating(true)}>
              New Term
            </Button>
          </>
        }
      />
      <div className="filter-bar">
        <input
          type="search"
          aria-label="Filter Terms"
          placeholder="Filter Terms and words to avoid"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="muted small">
          {terms.length} Term{terms.length === 1 ? "" : "s"}
          {project && ` · ${own} from this Project, ${terms.length - own} from the Workspace`}
        </span>
      </div>
      {terms.length === 0 ? (
        <EmptyState title="No Terms yet.">New Term names a concept, defines it and lists the words to avoid for it.</EmptyState>
      ) : (
        <section aria-label="Glossary" className="panel panel-flush glossary">
          {shown.length === 0 && <p className="glossary-none muted">No Term matches “{filter.trim()}”.</p>}
          {shown.map((term) => {
            const overrides = project && term.projectId === project.id && workspaceTerms.some((w) => sameName(w.name, term.name));
            const replaced = replacedIn.filter((p) => p.terms.some((t) => sameName(t.name, term.name)));
            return (
              <article key={term.id} className={`term${arrived.has(term.id) ? " arrived" : ""}`} aria-labelledby={`term-${term.id}`}>
                <header className="term-head">
                  <h2 id={`term-${term.id}`}>
                    <Link to={`/terms/${term.id}`}>{term.name}</Link>
                  </h2>
                  {overrides && <Chip tone="info">Overrides the Workspace Term</Chip>}
                  {replaced.map((p) => (
                    <Chip key={p.project.id} tone="info">
                      Replaced in {p.project.key}
                    </Chip>
                  ))}
                  <span className="term-scope">{term.projectId === null ? "Workspace" : (project?.key ?? "Project")}</span>
                  <span className="term-version">Version {term.version.number}</span>
                </header>
                {term.definition.trim() && <Markdown text={term.definition} mentions={[]} />}
                <Avoid words={term.avoid} />
              </article>
            );
          })}
        </section>
      )}
      <NewTerm place={place} open={creating} onOpenChange={setCreating} />
    </div>
  );
}

/** A dialog creating a Term in the Project or the Workspace, then showing it. */
function NewTerm({ place, open, onOpenChange }: { place: Place; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { error, busy, onSubmit } = useSubmit(async (form) => {
    const created = await api.createTerm(place, {
      name: field(form, "name"),
      definition: field(form, "definition"),
      avoid: wordsToAvoid(field(form, "avoid")),
    });
    navigate(`/terms/${created.id}`);
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={place.kind === "project" ? "New Project Term" : "New Workspace Term"}>
      <form onSubmit={onSubmit}>
        <Field label="Name">
          <input name="name" required maxLength={200} autoFocus />
        </Field>
        <Field label="Definition">
          <textarea name="definition" rows={4} className="markdown-source" />
        </Field>
        <Field label="Words to avoid" hint="Separated by commas.">
          <input name="avoid" placeholder="Issue, task" />
        </Field>
        <FormError error={error} />
        <DialogActions>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button type="submit" variant="primary" disabled={busy}>
            Create Term
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

/** A Project's glossary: its Terms over the Workspace's, same-named ones replaced. */
export function ProjectGlossary({ workspace, project }: { workspace: Workspace; project: ProjectSummary }) {
  usePlace("terms", project.id);
  const [data, setData] = useState<{ terms: Term[]; workspaceTerms: Term[] } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const latest = useLatest();
  const load = useCallback(
    () =>
      latest(
        Promise.all([api.glossary(project.id), api.terms({ kind: "workspace", id: workspace.id })]),
        ([terms, workspaceTerms]) => setData({ terms, workspaceTerms }),
        (e) => setFailure(e.message),
      ),
    [project.id, workspace.id, latest],
  );
  useEffect(load, [load]);
  // The Project's glossary shows the Workspace's Terms too, so a change to either is shown.
  useLiveEvents(workspace.id, (event) => {
    if (event.type === "reconnected" || (event.type === "term.changed" && (event.projectId === null || event.projectId === project.id))) load();
  });
  if (failure) return <FormError error={failure} />;
  if (!data) return <p className="muted">Loading…</p>;
  return <Glossary workspace={workspace} project={project} terms={data.terms} workspaceTerms={data.workspaceTerms} replacedIn={[]} />;
}

/** The Workspace's own Terms, under every Project's, each saying which Projects replace it. */
export function WorkspaceGlossary({ workspace }: { workspace: Workspace }) {
  usePlace("terms");
  const [data, setData] = useState<{ terms: Term[]; replacedIn: { project: ProjectSummary; terms: Term[] }[] } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const latest = useLatest();
  const load = useCallback(
    () =>
      latest(
        (async () => {
          const [terms, projects] = await Promise.all([api.terms({ kind: "workspace", id: workspace.id }), api.projects(workspace.id)]);
          const replacedIn = await Promise.all(projects.map(async (project) => ({ project, terms: await api.terms({ kind: "project", id: project.id }) })));
          return { terms, replacedIn };
        })(),
        setData,
        (e) => setFailure(e.message),
      ),
    [workspace.id, latest],
  );
  useEffect(load, [load]);
  // A Project's Term can replace one of the Workspace's, so every Term change is shown here, and each Project's key.
  useLiveEvents(workspace.id, (event) => {
    if (event.type === "reconnected" || event.type === "term.changed" || event.type === "project.created" || event.type === "project.changed") load();
  });
  if (failure) return <FormError error={failure} />;
  if (!data) return <p className="muted">Loading…</p>;
  return <Glossary workspace={workspace} project={null} terms={data.terms} workspaceTerms={data.terms} replacedIn={data.replacedIn} />;
}

/** A Term: read it, edit it, browse its Versions, and delete it. */
export function TermScreen({
  workspace,
  termId,
  onOtherWorkspace,
}: {
  workspace: Workspace;
  termId: string;
  /** Offered a Term of another Workspace; returns whether the screen switches to that Workspace. */
  onOtherWorkspace?: (workspaceId: string) => boolean;
}) {
  const [term, setTerm] = useState<Term | null>(null);
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { gone, failed, deleteHere } = useDeletedElsewhere();
  const otherWorkspace = useRef(onOtherWorkspace);
  otherWorkspace.current = onOtherWorkspace;
  usePlace("terms", term?.projectId ?? null);

  const load = useCallback(() => {
    api.term(termId).then(
      (found) => {
        if (found.workspaceId === workspace.id) setTerm(found);
        else if (!otherWorkspace.current?.(found.workspaceId)) setFailure("No such Term.");
      },
      (e: Error) => setFailure(e.message),
    );
  }, [termId, workspace.id]);
  useEffect(load, [load]);
  const latestTerm = useLatest();
  useLiveEvents(workspace.id, (event) => {
    if (event.type !== "reconnected" && !(event.type === "term.changed" && event.termId === termId)) return;
    latestTerm(api.term(termId), setTerm, failed);
  });
  const projectId = term?.projectId ?? null;
  useEffect(() => {
    if (projectId) api.project(projectId).then(setProject, () => setProject(null));
  }, [projectId]);

  if (failure) return <FormError error={failure} />;
  if (!term) return <p className="muted">Loading…</p>;
  const place: Place = term.projectId ? { kind: "project", id: term.projectId } : { kind: "workspace", id: term.workspaceId };
  const crumbs = knowledgeCrumbs(workspace, project, <Link to={glossaryPage(place)}>Terms</Link>);
  return (
    <div className="page">
      <PageHead
        crumbs={crumbs}
        title={term.name}
        large
        meta={
          <>
            <span>{term.projectId === null ? "Workspace Term" : `${project?.key ?? "Project"} Term`}</span>
            <span aria-hidden="true">·</span>
            <VersionMeta version={term.version} />
          </>
        }
        switcher={<LiveIndicator workspaceId={workspace.id} />}
        actions={
          !editing &&
          !gone && (
            <>
              <Menu label="More of this Term">
                <MenuItem tone="danger" onSelect={() => setDeleting(true)}>
                  Delete Term
                </MenuItem>
              </Menu>
              <Button variant="primary" onClick={() => setEditing(true)}>
                Edit
              </Button>
            </>
          )
        }
      />
      {gone && (
        <DeletedElsewhere back={{ to: glossaryPage(place), label: "Back to Terms" }}>this Term is no longer in its glossary.</DeletedElsewhere>
      )}
      {editing ? (
        <Editor
          term={term}
          onSaved={(next) => {
            setTerm(next);
            setEditing(false);
          }}
          onRebased={load}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div className="page-split">
          <TermBody name={term.name} definition={term.definition} avoid={term.avoid} />
          <aside className="side" aria-label="Term details">
            <Versions key={term.version.number} source={termVersions(term.id)} />
          </aside>
        </div>
      )}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete the Term ${term.name}?`}
        confirm="Delete"
        onConfirm={async () => {
          await deleteHere(() => api.deleteTerm(term.id));
          navigate(glossaryPage(place));
        }}
      >
        It goes with all its Versions{term.projectId ? ", and the Workspace's Term of the same name, if any, applies again" : ""}.
      </ConfirmDialog>
    </div>
  );
}

/**
 * The Term's name, definition and words to avoid, editable. A save names the Version it's based on; one based on
 * an outdated Version is refused with the current one, shown above the draft so its changes can be folded in.
 */
function Editor({
  term,
  onSaved,
  onRebased,
  onCancel,
}: {
  term: Term;
  onSaved: (next: Term) => void;
  /** The draft is now based on the Term's current Version, which the screen shows again. */
  onRebased: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(term.name);
  const [definition, setDefinition] = useState(term.definition);
  const [avoid, setAvoid] = useState(term.avoid.join(", "));
  const [base, setBase] = useState(term.version.number);
  const [current, setCurrent] = useState<TermVersion | null>(null);
  const { error, busy, onSubmit } = useSubmit(async () => {
    try {
      onSaved(await api.editTerm(term.id, { baseVersion: base, name, definition, avoid: wordsToAvoid(avoid) }));
    } catch (e) {
      if (e instanceof ApiError && e.code === "outdated_version") setCurrent(e.body.current as TermVersion);
      throw e;
    }
  });
  return (
    <form onSubmit={onSubmit} className="editor">
      {current && (
        <Banner tone="info" label="Saved meanwhile">
          <p>
            <strong>{current.actor.name}</strong> saved Version {current.number} while you were editing, so your save was
            refused. Your draft is kept: fold their changes into it, then save again.
          </p>
          <p>
            Their name: <strong>{current.name}</strong>. Their words to avoid: {current.avoid.join(", ") || "none"}.
          </p>
          <Diff from="Your definition" to={`Version ${current.number}`} lines={lineDiff(definition, current.definition)} label="Their changes" />
          <div>
            <Button
              onClick={() => {
                setBase(current.number);
                setCurrent(null);
                onRebased();
              }}
            >
              Base my draft on Version {current.number}
            </Button>
          </div>
        </Banner>
      )}
      <Field label="Name">
        <input value={name} required maxLength={200} onChange={(e) => setName(e.target.value)} className="title-input" />
      </Field>
      <div className="editor-panes">
        <Field label="Definition">
          <textarea value={definition} rows={12} className="markdown-source" onChange={(e) => setDefinition(e.target.value)} />
        </Field>
        <section aria-label="Preview" className="editor-preview">
          <span className="field-label">Preview</span>
          <TermBody definition={definition} avoid={wordsToAvoid(avoid)} />
        </section>
      </div>
      <Field label="Words to avoid" hint="Separated by commas.">
        <input value={avoid} onChange={(e) => setAvoid(e.target.value)} />
      </Field>
      {!current && <FormError error={error} />}
      <Actions>
        {/* Until the draft is based on the Version saved meanwhile, a save would only be refused again. */}
        <Button type="submit" variant="primary" disabled={busy || current !== null}>
          Save as Version {(current?.number ?? base) + 1}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </Actions>
    </form>
  );
}

/** A Term as it reads, drawn as a Document's body is: its definition, then the words to avoid. Named, it is an article. */
function TermBody({ name, definition, avoid }: { name?: string; definition: string; avoid: string[] }) {
  return (
    <DocumentBody
      body={definition}
      label={name}
      after={<Avoid words={avoid} />}
      empty={
        <div className="prose">
          <p className="muted">No definition yet.</p>
          <Avoid words={avoid} />
        </div>
      }
    />
  );
}

/** A Term's Version read as the shared Versions panel reads one: its name as the title, its definition as the body. */
type ReadTermVersion = TermVersion & { title: string; body: string };
const read = (version: TermVersion): ReadTermVersion => ({ ...version, title: version.name, body: version.definition });

/** The definitions' lines, then, when either Version has any, the words to avoid one to a line under "Avoid:". */
const comparedLines = ({ lines, avoid }: TermComparison) =>
  avoid.length === 0 ? lines : [...lines, { change: "same" as const, text: "" }, { change: "same" as const, text: "Avoid:" }, ...avoid];

/** Where a Term's Versions come from, for the panel a Document's and a Decision's Versions are listed in. */
const termVersions = (termId: string) => ({
  list: () => api.termVersions(termId).then((versions) => versions.map(read)),
  read: (number: number) => api.termVersion(termId, number).then(read),
  compare: (from: number, to: number) =>
    api.compareTermVersions(termId, from, to).then((comparison) => ({
      from: read(comparison.from),
      to: read(comparison.to),
      lines: comparedLines(comparison),
    })),
  show: (version: ReadTermVersion) => <TermBody name={version.name} definition={version.definition} avoid={version.avoid} />,
});
