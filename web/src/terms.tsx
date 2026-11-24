import { useActiveProject, useAddresses, useCanonicalAddress } from "./addresses.js";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { api, ApiError, type Mention, type Place, type ProjectSummary, type Term, type TermComparison, type TermDetail, type TermVersion, type Workspace } from "./api.js";
import { DocumentBody, VersionMeta, Versions } from "./documents.js";
import { ExportLink } from "./export.js";
import { field, useSubmit } from "./forms.js";
import { usePlace } from "./frame.js";
import { Markdown } from "./markdown.js";
import { MentionedIn } from "./mentioned-in.js";
import { knowledgeCrumbs } from "./projects.js";
import { Link, navigate } from "./router.js";
import { useArrivals, useDeletedElsewhere, useLatest, useLiveEvents } from "./live.js";
import { Actions, Banner, Button, DeletedElsewhere, EmptyState, Field, FormError, LiveIndicator, PageHead } from "./ui/controls.js";
import { Diff, lineDiff } from "./ui/diff.js";
import { Chip } from "./ui/labels.js";
import { ProjectNote } from "./write-access.js";
import { ConfirmDialog, Dialog, DialogActions, DialogClose, Menu, MenuItem } from "./ui/overlays.js";
import { RichEditor } from "./ui/lazy-rich-editor.js";


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

/** Whether a Term's name or one of its words to avoid holds the typed filter, already trimmed and lower-cased. */
const matches = (term: Term, typed: string) =>
  !typed || term.name.toLowerCase().includes(typed) || term.avoid.some((word) => word.toLowerCase().includes(typed));

/**
 * Terms as a glossary, in stacked sections: on a Project's page its own Terms, then the Workspace's; on the
 * Workspace's page only the Workspace's. A Project Term replacing a Workspace Term of the same name says so, and that
 * Workspace Term stays listed, muted, saying where it is replaced. One filter box filters both sections.
 */
function Glossary({
  workspace,
  project,
  projectTerms,
  workspaceTerms,
}: {
  workspace: Workspace;
  project: ProjectSummary | null;
  /** The Project's own Terms; empty on the Workspace's page. */
  projectTerms: Term[];
  /** The Workspace's own Terms. */
  workspaceTerms: Term[];
}) {
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState<Place | null>(null);
  const workspacePlace: Place = { kind: "workspace", id: workspace.id };
  const typed = filter.trim().toLowerCase();
  const arrived = useArrivals([...projectTerms, ...workspaceTerms].map((t) => t.id));
  const section = { filter: filter.trim(), typed, arrived };
  return (
    <div className="page">
      <PageHead
        crumbs={knowledgeCrumbs(workspace, project, "Terms")}
        title="Terms"
        switcher={<LiveIndicator workspaceId={workspace.id} />}
        actions={<ExportLink place={project ? { kind: "project", id: project.id } : workspacePlace} />}
      />
      {project && <ProjectNote project={project} />}
      <div className="filter-bar">
        <input
          type="search"
          aria-label="Filter Terms"
          placeholder="Filter Terms and words to avoid"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      {project && (
        <TermSection
          {...section}
          id="project"
          heading={
            <>
              <span className="mono">{project.key}</span> {project.name}
            </>
          }
          terms={projectTerms}
          overrides={(term) => workspaceTerms.some((w) => sameName(w.name, term.name))}
          onNew={project.access === "write" ? () => setCreating({ kind: "project", id: project.id }) : null}
          empty="No Project Terms yet."
        />
      )}
      <TermSection
        {...section}
        id="workspace"
        heading="Workspace"
        terms={workspaceTerms}
        replacedIn={project && ((term) => (projectTerms.some((p) => sameName(p.name, term.name)) ? project.key : null))}
        onNew={() => setCreating(workspacePlace)}
        empty="No Workspace Terms yet."
      />
      {creating && <NewTerm place={creating} open onOpenChange={(open) => !open && setCreating(null)} />}
    </div>
  );
}

/** One glossary's Terms under its heading, with its count, its New Term and its own empty state. */
function TermSection({
  id,
  heading,
  terms,
  filter,
  typed,
  arrived,
  overrides,
  replacedIn,
  onNew,
  empty,
}: {
  id: string;
  heading: ReactNode;
  terms: Term[];
  filter: string;
  typed: string;
  arrived: Set<string>;
  /** Whether a Term replaces a Workspace Term of the same name. */
  overrides?: (term: Term) => boolean;
  /** The key of the Project replacing a Workspace Term, if it is replaced. */
  replacedIn?: ((term: Term) => string | null) | null;
  /** Opens New Term for this section; null where it is only read. */
  onNew: (() => void) | null;
  empty: string;
}) {
  const to = useAddresses();
  const shown = terms.filter((t) => matches(t, typed));
  const headingId = `glossary-${id}`;
  return (
    <section className="knowledge-section" aria-labelledby={headingId}>
      <header className="knowledge-section-head">
        <h2 id={headingId}>{heading}</h2>
        <span className="muted small">
          {typed ? `${shown.length} of ${terms.length}` : terms.length} Term{terms.length === 1 ? "" : "s"}
        </span>
        {onNew && (
          <Button size="small" onClick={onNew}>
            New Term
          </Button>
        )}
      </header>
      {terms.length === 0 ? (
        <EmptyState title={empty}>New Term names a concept, defines it and lists the words to avoid for it.</EmptyState>
      ) : (
        <div className="panel panel-flush glossary">
          {shown.length === 0 && <p className="glossary-none muted">No Term matches “{filter}”.</p>}
          {shown.map((term) => {
            const replacing = replacedIn?.(term) ?? null;
            const classes = ["term", arrived.has(term.id) && "arrived", replacing && "replaced"].filter(Boolean).join(" ");
            return (
              <article key={term.id} className={classes} aria-labelledby={`term-${term.id}`}>
                <header className="term-head">
                  <h3 id={`term-${term.id}`}>
                    <Link to={to.term(term)}>{term.name}</Link>
                  </h3>
                  {overrides?.(term) && <Chip tone="info">Overrides the Workspace Term</Chip>}
                  {replacing && <Chip tone="info">Replaced in {replacing}</Chip>}
                  <span className="term-version">Version {term.version.number}</span>
                </header>
                {term.definition.trim() && <Markdown text={term.definition} mentions={term.mentions} />}
                <Avoid words={term.avoid} />
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** A dialog creating a Term in the Project or the Workspace, then showing it. */
function NewTerm({ place, open, onOpenChange }: { place: Place; open: boolean; onOpenChange: (open: boolean) => void }) {
  const to = useAddresses();
  const [definition, setDefinition] = useState("");
  const { error, busy, onSubmit } = useSubmit(async (form) => {
    const created = await api.createTerm(place, {
      name: field(form, "name"),
      definition,
      avoid: wordsToAvoid(field(form, "avoid")),
    });
    navigate(to.term(created));
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={place.kind === "project" ? "New Project Term" : "New Workspace Term"}>
      <form onSubmit={onSubmit}>
        <Field label="Name">
          <input name="name" required maxLength={200} autoFocus />
        </Field>
        <RichEditor label="Definition" compact value={definition} onChange={setDefinition} />
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
  const [data, setData] = useState<{ projectTerms: Term[]; workspaceTerms: Term[] } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const latest = useLatest();
  const load = useCallback(
    () =>
      latest(
        Promise.all([api.terms({ kind: "project", id: project.id }), api.terms({ kind: "workspace", id: workspace.id })]),
        ([projectTerms, workspaceTerms]) => setData({ projectTerms, workspaceTerms }),
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
  return <Glossary workspace={workspace} project={project} projectTerms={data.projectTerms} workspaceTerms={data.workspaceTerms} />;
}

/** The Workspace's own Terms, alone: a Project's page shows them under its own. */
export function WorkspaceGlossary({ workspace }: { workspace: Workspace }) {
  usePlace("terms");
  const [terms, setTerms] = useState<Term[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const latest = useLatest();
  const load = useCallback(
    () => latest(api.terms({ kind: "workspace", id: workspace.id }), setTerms, (e) => setFailure(e.message)),
    [workspace.id, latest],
  );
  useEffect(load, [load]);
  useLiveEvents(workspace.id, (event) => {
    if (event.type === "reconnected" || (event.type === "term.changed" && event.projectId === null)) load();
  });
  if (failure) return <FormError error={failure} />;
  if (!terms) return <p className="muted">Loading…</p>;
  return <Glossary workspace={workspace} project={null} projectTerms={[]} workspaceTerms={terms} />;
}

/** A Term: read it, edit it, browse its Versions, and delete it. */
export function TermScreen({
  workspace,
  termId,
}: {
  workspace: Workspace;
  termId: string;
}) {
  const to = useAddresses();
  const activeProject = useActiveProject();
  const [term, setTerm] = useState<TermDetail | null>(null);
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { gone, failed, deleteHere } = useDeletedElsewhere();
  usePlace("terms", term?.projectId ?? null);

  const load = useCallback(() => {
    api.term(termId).then(
      (found) => {
        if (found.workspaceId === workspace.id) setTerm(found);
        else setFailure("No such Term.");
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
  useCanonicalAddress(term && !gone ? to.term(term) : null);

  if (failure) return <FormError error={failure} />;
  if (!term) return <p className="muted">Loading…</p>;
  // A Workspace Term's list is the active Project's Terms page, which shows the Workspace's under the Project's.
  const list = term.projectId ? to.place({ kind: "project", id: term.projectId }, "glossary") : to.knowledge(activeProject, "glossary");
  const crumbs = knowledgeCrumbs(workspace, project, <Link to={list}>Terms</Link>);
  // With Read in its Project, the Term is only read: no Edit or Delete.
  const canWrite = !project || project.access === "write";
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
          !gone &&
          canWrite && (
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
      {project && <ProjectNote project={project} />}
      {gone && (
        <DeletedElsewhere back={{ to: list, label: "Back to Terms" }}>this Term is no longer in its glossary.</DeletedElsewhere>
      )}
      {editing && canWrite ? (
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
          <TermBody name={term.name} definition={term.definition} avoid={term.avoid} mentions={term.mentions} />
          <aside className="side" aria-label="Term details">
            <MentionedIn texts={term.mentionedIn} />
            <Versions current={term.version.number} source={termVersions(term.id)} />
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
          navigate(list);
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
  onSaved: (next: TermDetail) => void;
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
      <RichEditor label="Definition" value={definition} onChange={setDefinition} />
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
function TermBody({
  name,
  definition,
  avoid,
  mentions,
}: {
  name?: string;
  definition: string;
  avoid: string[];
  mentions?: Mention[];
}) {
  return (
    <DocumentBody
      body={definition}
      mentions={mentions}
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
