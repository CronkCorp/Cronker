import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type Place, type Term, type TermVersion, type Workspace } from "./api.js";
import { ExportLink } from "./export.js";
import { field, useSubmit } from "./forms.js";
import { Markdown } from "./markdown.js";
import { Link, navigate } from "./router.js";

/** Where a glossary is shown: a Project's Glossary tab, or the Workspace's Glossary page. */
const glossaryPage = (place: Place) => (place.kind === "project" ? `/projects/${place.id}/glossary` : `/workspaces/${place.id}/glossary`);

/** Words to avoid as typed: separated by commas, each trimmed, blanks dropped. */
const wordsToAvoid = (text: string) =>
  text
    .split(",")
    .map((word) => word.trim())
    .filter(Boolean);

const versionLine = (version: { number: number; actor: { name: string }; savedAt: string }) =>
  `Version ${version.number} by ${version.actor.name}, ${new Date(version.savedAt).toLocaleString()}`;

/** Terms as a glossary: each with its definition and the words to avoid; marked when it is the Workspace's. */
function TermList({ terms, markWorkspace }: { terms: Term[]; markWorkspace: boolean }) {
  return (
    <section aria-label="Glossary" className="glossary">
      {terms.length === 0 && <p>No Terms yet.</p>}
      {terms.map((term) => (
        <article key={term.id} className="term">
          <h2>
            <Link to={`/terms/${term.id}`}>{term.name}</Link>
          </h2>
          {markWorkspace && term.projectId === null && <p className="muted">Workspace Term</p>}
          {term.definition.trim() && <Markdown text={term.definition} mentions={[]} />}
          {term.avoid.length > 0 && <p className="muted">Avoid: {term.avoid.join(", ")}</p>}
        </article>
      ))}
    </section>
  );
}

/** A form creating a Term in the Project or the Workspace, then showing it. */
function NewTerm({ place }: { place: Place }) {
  const { error, busy, onSubmit } = useSubmit(async (form) => {
    const created = await api.createTerm(place, {
      name: field(form, "name"),
      definition: field(form, "definition"),
      avoid: wordsToAvoid(field(form, "avoid")),
    });
    navigate(`/terms/${created.id}`);
  });
  return (
    <form onSubmit={onSubmit} className="term-form">
      <h2>New Term</h2>
      <label>
        New Term name
        <input name="name" required maxLength={200} />
      </label>
      <label>
        Definition
        <textarea name="definition" rows={3} />
      </label>
      <label>
        Words to avoid
        <input name="avoid" placeholder="Separated by commas" />
      </label>
      <button type="submit" disabled={busy}>
        Create Term
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

/** Loads a list of Terms, showing failures and the wait. */
function useTerms(load: () => Promise<Term[]>, key: string) {
  const [terms, setTerms] = useState<Term[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    load().then(setTerms, (e: Error) => setFailure(e.message));
  }, [key]);
  return { terms, failure };
}

/** A Project's glossary: its Terms over the Workspace's, same-named ones replaced; and a form for a Project Term. */
export function ProjectGlossary({ projectId }: { projectId: string }) {
  const { terms, failure } = useTerms(() => api.glossary(projectId), projectId);
  if (failure) return <p role="alert">{failure}</p>;
  if (!terms) return <p>Loading…</p>;
  return (
    <>
      <ExportLink place={{ kind: "project", id: projectId }} />
      <p className="muted">The Project's Terms over the Workspace's: a Project Term replaces a Workspace Term of the same name.</p>
      <TermList terms={terms} markWorkspace />
      <NewTerm place={{ kind: "project", id: projectId }} />
    </>
  );
}

/** The Workspace's own Terms, under every Project's. */
export function WorkspaceGlossary({ workspace }: { workspace: Workspace }) {
  const { terms, failure } = useTerms(() => api.terms({ kind: "workspace", id: workspace.id }), workspace.id);
  return (
    <>
      <h1>{workspace.name} Glossary</h1>
      <ExportLink place={{ kind: "workspace", id: workspace.id }} />
      {failure ? (
        <p role="alert">{failure}</p>
      ) : !terms ? (
        <p>Loading…</p>
      ) : (
        <>
          <TermList terms={terms} markWorkspace={false} />
          <NewTerm place={{ kind: "workspace", id: workspace.id }} />
        </>
      )}
    </>
  );
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
  const [failure, setFailure] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const otherWorkspace = useRef(onOtherWorkspace);
  otherWorkspace.current = onOtherWorkspace;

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

  if (failure) return <p role="alert">{failure}</p>;
  if (!term) return <p>Loading…</p>;
  const place: Place = term.projectId ? { kind: "project", id: term.projectId } : { kind: "workspace", id: term.workspaceId };
  return (
    <article className="document">
      <p>
        <Link to={glossaryPage(place)}>{place.kind === "project" ? "Project Glossary" : "Workspace Glossary"}</Link>
      </p>
      <h1>{term.name}</h1>
      <p className="muted">{versionLine(term.version)}</p>
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
        <>
          <div className="actions">
            <button type="button" onClick={() => setEditing(true)}>
              Edit
            </button>
          </div>
          {term.definition.trim() ? <Markdown text={term.definition} mentions={[]} /> : <p className="muted">No definition.</p>}
          {term.avoid.length > 0 && <p>Avoid: {term.avoid.join(", ")}</p>}
          <Delete term={term} onDeleted={() => navigate(glossaryPage(place))} />
        </>
      )}
      <Versions key={term.version.number} term={term} />
    </article>
  );
}

/**
 * The Term's name, definition and words to avoid, editable. A save names the Version it's based on; one based on
 * an outdated Version is refused with the current one, shown beside the draft so its changes can be merged in.
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
    <form onSubmit={onSubmit} className="term-form">
      <label>
        Name
        <input value={name} required maxLength={200} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Definition
        <textarea value={definition} rows={6} onChange={(e) => setDefinition(e.target.value)} />
      </label>
      <label>
        Words to avoid
        <input value={avoid} placeholder="Separated by commas" onChange={(e) => setAvoid(e.target.value)} />
      </label>
      {error && <p role="alert">{error}</p>}
      {current && (
        <section aria-label="Current Version" className="conflict">
          <h2>{versionLine(current)}</h2>
          <p className="muted">Merge its changes into your draft, then save based on it.</p>
          <dl>
            <dt>Name</dt>
            <dd>{current.name}</dd>
            <dt>Definition</dt>
            <dd>
              <pre>{current.definition}</pre>
            </dd>
            <dt>Words to avoid</dt>
            <dd>{current.avoid.join(", ") || "None"}</dd>
          </dl>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setBase(current.number);
              setCurrent(null);
              onRebased();
            }}
          >
            Base my draft on Version {current.number}
          </button>
        </section>
      )}
      <div className="actions">
        <button type="submit" disabled={busy}>
          Save
        </button>
        <button type="button" className="link" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Delete({ term, onDeleted }: { term: Term; onDeleted: () => void }) {
  const { error, busy, onSubmit } = useSubmit(async () => {
    if (!window.confirm(`Delete the Term ${term.name} and all its Versions?`)) return;
    await api.deleteTerm(term.id);
    onDeleted();
  });
  return (
    <>
      <form onSubmit={onSubmit} className="inline">
        <button type="submit" className="secondary" disabled={busy}>
          Delete Term
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
    </>
  );
}

/** The Term's Versions, oldest first, each with what it said. */
function Versions({ term }: { term: Term }) {
  const [versions, setVersions] = useState<TermVersion[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    api.termVersions(term.id).then(setVersions, (e: Error) => setFailure(e.message));
  }, [term.id]);
  if (failure) return <p role="alert">{failure}</p>;
  if (!versions) return null;
  return (
    <section aria-label="Versions" className="versions">
      <h2>Versions</h2>
      <ol>
        {versions.map((version) => (
          <li key={version.number}>
            <details>
              <summary>{versionLine(version)}</summary>
              <p>
                <strong>{version.name}</strong>
              </p>
              <pre>{version.definition}</pre>
              {version.avoid.length > 0 && <p className="muted">Avoid: {version.avoid.join(", ")}</p>}
            </details>
          </li>
        ))}
      </ol>
    </section>
  );
}
