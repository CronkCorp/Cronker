import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  ApiError,
  type Comparison,
  type Document,
  type DocumentSummary,
  type Tree,
  type Version,
  type VersionWithBody,
  type Workspace,
} from "./api.js";
import { field, useSubmit } from "./forms.js";
import { Markdown } from "./markdown.js";
import { Link, navigate } from "./router.js";

/** Nests a page tree's Documents, listed in tree order, under their parents. */
function childrenOf(documents: DocumentSummary[]): Map<string | null, DocumentSummary[]> {
  const children = new Map<string | null, DocumentSummary[]>();
  for (const document of documents) {
    children.set(document.parentId, [...(children.get(document.parentId) ?? []), document]);
  }
  return children;
}

/** Where a page tree is shown: a Project's Documents tab, or the Workspace's Documents page. */
const treePage = (tree: Tree) => (tree.kind === "project" ? `/projects/${tree.id}/documents` : `/workspaces/${tree.id}/documents`);

/** A page tree's Documents, nested, and a form to create one at its top. */
export function PageTree({ tree }: { tree: Tree }) {
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    api.documents(tree).then(setDocuments, (e: Error) => setFailure(e.message));
  }, [tree.kind, tree.id]);

  const { error, busy, onSubmit } = useSubmit(async (form) => {
    const created = await api.createDocument(tree, { title: field(form, "title") });
    navigate(`/documents/${created.id}`);
  });

  if (failure) return <p role="alert">{failure}</p>;
  if (!documents) return <p>Loading…</p>;
  const children = childrenOf(documents);
  const branch = (parentId: string | null) => (
    <ul>
      {(children.get(parentId) ?? []).map((document) => (
        <li key={document.id}>
          <Link to={`/documents/${document.id}`}>{document.title}</Link>
          {children.has(document.id) && branch(document.id)}
        </li>
      ))}
    </ul>
  );
  return (
    <section aria-label="Page tree" className="page-tree">
      {documents.length === 0 ? <p>No Documents yet.</p> : branch(null)}
      <form onSubmit={onSubmit} className="inline">
        <label>
          New Document title
          <input name="title" required maxLength={300} />
        </label>
        <button type="submit" disabled={busy}>
          Create Document
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

/** The Workspace's own page tree, separate from its Projects'. */
export function WorkspaceDocuments({ workspace }: { workspace: Workspace }) {
  return (
    <>
      <h1>{workspace.name} Documents</h1>
      <PageTree tree={{ kind: "workspace", id: workspace.id }} />
    </>
  );
}

const versionLine = (version: { number: number; actor: { name: string }; savedAt: string }) =>
  `Version ${version.number} by ${version.actor.name}, ${new Date(version.savedAt).toLocaleString()}`;

/**
 * A Document: read it, edit it as Markdown with a preview, move it in its page tree, and browse its Versions. A
 * Report is listed with its Ticket instead, so it leads back there and doesn't move.
 */
export function DocumentScreen({
  workspace,
  documentId,
  onOtherWorkspace,
}: {
  workspace: Workspace;
  documentId: string;
  /** Offered a Document of another Workspace; returns whether the screen switches to that Workspace. */
  onOtherWorkspace?: (workspaceId: string) => boolean;
}) {
  const [document, setDocument] = useState<Document | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [versionsShown, setVersionsShown] = useState(0);
  const otherWorkspace = useRef(onOtherWorkspace);
  otherWorkspace.current = onOtherWorkspace;

  const load = useCallback(() => {
    api.document(documentId).then(
      (found) => {
        if (found.workspaceId === workspace.id) setDocument(found);
        else if (!otherWorkspace.current?.(found.workspaceId)) setFailure("No such Document.");
      },
      (e: Error) => setFailure(e.message),
    );
  }, [documentId, workspace.id]);
  useEffect(load, [load]);

  const saved = (next: Document) => {
    setDocument(next);
    setVersionsShown((n) => n + 1);
  };

  if (failure) return <p role="alert">{failure}</p>;
  if (!document) return <p>Loading…</p>;
  const tree: Tree = document.projectId
    ? { kind: "project", id: document.projectId }
    : { kind: "workspace", id: document.workspaceId };
  // Where the Document is listed: its Ticket for a Report, otherwise its page tree.
  const home = document.ticketId
    ? { path: `/tickets/${document.ticketId}`, name: "Report on its Ticket" }
    : { path: treePage(tree), name: tree.kind === "project" ? "Project Documents" : "Workspace Documents" };
  return (
    <article className="document">
      <p>
        <Link to={home.path}>{home.name}</Link>
      </p>
      <h1>{document.title}</h1>
      <p className="muted">{versionLine(document.version)}</p>
      {editing ? (
        <Editor
          document={document}
          onSaved={(next) => {
            saved(next);
            setEditing(false);
          }}
          onRebased={() => {
            load();
            setVersionsShown((n) => n + 1);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <div className="actions">
            <button type="button" onClick={() => setEditing(true)}>
              Edit
            </button>
          </div>
          {document.body.trim() ? <Markdown text={document.body} mentions={[]} /> : <p className="muted">Empty.</p>}
          {!document.ticketId && <Move document={document} tree={tree} onMoved={setDocument} />}
          <Delete document={document} onDeleted={() => navigate(home.path)} />
        </>
      )}
      <Versions key={versionsShown} document={document} />
    </article>
  );
}

/**
 * The Markdown text area with its preview. A save names the Version it's based on; one based on an outdated
 * Version is refused with the current one, shown beside the draft so its changes can be merged in by hand.
 */
function Editor({
  document,
  onSaved,
  onRebased,
  onCancel,
}: {
  document: Document;
  onSaved: (next: Document) => void;
  /** The draft is now based on the Document's current Version, which the screen shows again. */
  onRebased: () => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(document.title);
  const [body, setBody] = useState(document.body);
  const [base, setBase] = useState(document.version.number);
  const [current, setCurrent] = useState<VersionWithBody | null>(null);
  const { error, busy, onSubmit } = useSubmit(async () => {
    try {
      onSaved(await api.editDocument(document.id, { baseVersion: base, title, body }));
    } catch (e) {
      if (e instanceof ApiError && e.code === "outdated_version") setCurrent(e.body.current as VersionWithBody);
      throw e;
    }
  });
  return (
    <form onSubmit={onSubmit} className="editor">
      <label>
        Title
        <input value={title} required maxLength={300} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <div className="editor-panes">
        <label>
          Markdown
          <textarea value={body} rows={18} onChange={(e) => setBody(e.target.value)} />
        </label>
        <section aria-label="Preview">
          <h2>Preview</h2>
          <Markdown text={body} mentions={[]} />
        </section>
      </div>
      {error && <p role="alert">{error}</p>}
      {current && (
        <section aria-label="Current Version" className="conflict">
          <h2>{versionLine(current)}</h2>
          <p className="muted">Merge its changes into your draft, then save based on it.</p>
          <pre>{current.body}</pre>
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

/** Moves the Document under another parent of its page tree, or to its top, at a place among its siblings. */
function Move({ document, tree, onMoved }: { document: Document; tree: Tree; onMoved: (next: Document) => void }) {
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null);
  useEffect(() => {
    api.documents(tree).then(setDocuments, () => setDocuments([]));
  }, [tree.kind, tree.id, document.parentId, document.position]);
  const { error, busy, onSubmit } = useSubmit(async (form) => {
    const place = field(form, "position");
    onMoved(
      await api.editDocument(document.id, {
        parentId: field(form, "parentId") || null,
        ...(place ? { position: Number(place) } : {}),
      }),
    );
  });
  // The parent is chosen among the page tree's Documents, so the form waits for them.
  if (!documents) return null;
  return (
    <>
      <form onSubmit={onSubmit} className="inline move" key={`${document.parentId} ${document.position} ${documents.length}`}>
        <label>
          Parent
          <select name="parentId" defaultValue={document.parentId ?? ""}>
            <option value="">Top of the page tree</option>
            {documents
              .filter((d) => d.id !== document.id)
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                </option>
              ))}
          </select>
        </label>
        <label>
          Place among its siblings
          <input name="position" type="number" min={0} placeholder="Last" />
        </label>
        <button type="submit" className="secondary" disabled={busy}>
          Move
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
    </>
  );
}

function Delete({ document, onDeleted }: { document: Document; onDeleted: () => void }) {
  const { error, busy, onSubmit } = useSubmit(async () => {
    if (!window.confirm(`Delete ${document.title} and all its Versions?`)) return;
    await api.deleteDocument(document.id);
    onDeleted();
  });
  return (
    <>
      <form onSubmit={onSubmit} className="inline">
        <button type="submit" className="secondary" disabled={busy}>
          Delete Document
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
    </>
  );
}

/** The Document's Versions, oldest first: read any one, or compare two. */
function Versions({ document }: { document: Document }) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [shown, setShown] = useState<VersionWithBody | null>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    api.versions(document.id).then(setVersions, (e: Error) => setFailure(e.message));
  }, [document.id]);

  const read = (number: number) => {
    setComparison(null);
    api.version(document.id, number).then(setShown, (e: Error) => setFailure(e.message));
  };
  const { error, busy, onSubmit } = useSubmit(async (form) => {
    setShown(null);
    setComparison(await api.compareVersions(document.id, Number(field(form, "from")), Number(field(form, "to"))));
  });

  if (failure) return <p role="alert">{failure}</p>;
  if (!versions) return null;
  const last = versions.at(-1)?.number ?? 1;
  return (
    <section aria-label="Versions" className="versions">
      <h2>Versions</h2>
      <ol>
        {versions.map((version) => (
          <li key={version.number}>
            <button type="button" className="link" onClick={() => read(version.number)}>
              {versionLine(version)}
            </button>{" "}
            <span className="muted">{version.title}</span>
          </li>
        ))}
      </ol>
      {versions.length > 1 && (
        <form onSubmit={onSubmit} className="inline">
          <label>
            From
            <select name="from" defaultValue={Math.max(1, last - 1)}>
              {versions.map((v) => (
                <option key={v.number} value={v.number}>
                  Version {v.number}
                </option>
              ))}
            </select>
          </label>
          <label>
            To
            <select name="to" defaultValue={last}>
              {versions.map((v) => (
                <option key={v.number} value={v.number}>
                  Version {v.number}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="secondary" disabled={busy}>
            Compare
          </button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
      {shown && (
        <section aria-label={`Version ${shown.number}`} className="version">
          <h3>
            Version {shown.number}: {shown.title}
          </h3>
          <Markdown text={shown.body} mentions={[]} />
        </section>
      )}
      {comparison && (
        <section aria-label="Comparison" className="comparison">
          <h3>
            Version {comparison.from.number} → Version {comparison.to.number}
            {comparison.from.title !== comparison.to.title && ` (${comparison.from.title} → ${comparison.to.title})`}
          </h3>
          <pre>
            {comparison.lines.map((line, i) => (
              <div key={i} className={line.change}>
                {line.change === "added" ? "+ " : line.change === "removed" ? "- " : "  "}
                {line.text}
              </div>
            ))}
          </pre>
        </section>
      )}
    </section>
  );
}
