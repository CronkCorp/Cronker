import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from "react";
import {
  api,
  ApiError,
  type Actor as ActorInfo,
  type Attachment,
  type AttachmentOwner,
  type Comparison,
  type Document,
  type DocumentSummary,
  type ProjectSummary,
  type Ticket,
  type Tree,
  type Version,
  type VersionWithBody,
  type Workspace,
} from "./api.js";
import { Attachments, markdownReference } from "./attachments.js";
import { field, useSubmit } from "./forms.js";
import { usePlace } from "./frame.js";
import { useLatest, useLiveEvents } from "./live.js";
import { Markdown } from "./markdown.js";
import { knowledgeCrumbs, ScopeSwitch } from "./projects.js";
import { Link, navigate } from "./router.js";
import { Actor } from "./ui/actor.js";
import { Actions, Banner, Button, EmptyState, Field, FormError, PageHead, Panel, RelativeTime, workspaceCrumb } from "./ui/controls.js";
import { Diff, lineDiff } from "./ui/diff.js";
import { ConfirmDialog, Dialog, DialogActions, DialogClose, Menu, MenuItem } from "./ui/overlays.js";

/** Nests a page tree's Documents, listed in tree order, under their parents. */
function childrenOf(documents: DocumentSummary[]): Map<string | null, DocumentSummary[]> {
  const children = new Map<string | null, DocumentSummary[]>();
  for (const document of documents) {
    children.set(document.parentId, [...(children.get(document.parentId) ?? []), document]);
  }
  return children;
}

/** Where a page tree is shown: a Project's Documents page, or the Workspace's. */
const treePage = (tree: Tree) => (tree.kind === "project" ? `/projects/${tree.id}/documents` : `/workspaces/${tree.id}/documents`);

/** Who saved a Version and when, as a line of meta. */
export function VersionMeta({ version }: { version: { number: number; actor: ActorInfo; savedAt: string } }) {
  return (
    <span className="version-meta">
      <span>Version {version.number}</span>
      <span aria-hidden="true">·</span>
      <Actor actor={version.actor} />
      <RelativeTime at={version.savedAt} />
    </span>
  );
}

/** "Version 2 by ada@example.com", as a refusal or a Version's title names it. */
export const versionLine = (version: { number: number; actor: { name: string } }) =>
  `Version ${version.number} by ${version.actor.name}`;

/** A page tree's Documents, nested, under a page head with the scope switch and New Document. */
function PageTree({ workspace, project }: { workspace: Workspace; project: ProjectSummary | null }) {
  const tree: Tree = project ? { kind: "project", id: project.id } : { kind: "workspace", id: workspace.id };
  usePlace("documents", project?.id ?? null);
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    api.documents(tree).then(setDocuments, (e: Error) => setFailure(e.message));
  }, [tree.kind, tree.id]);

  const { error, busy, onSubmit } = useSubmit(async (form) => {
    const created = await api.createDocument(tree, { title: field(form, "title") });
    navigate(`/documents/${created.id}`);
  });

  const children = documents ? childrenOf(documents) : new Map<string | null, DocumentSummary[]>();
  const branch = (parentId: string | null, depth: number): ReactNode =>
    (children.get(parentId) ?? []).map((document) => (
      <li key={document.id}>
        <Link to={`/documents/${document.id}`} className="row" style={{ paddingLeft: 16 + depth * 20 }}>
          <span className="row-title">{document.title}</span>
          <span className="row-meta">
            <span className="muted small">Version {document.version.number}</span>
            <RelativeTime at={document.version.savedAt} />
          </span>
        </Link>
        {children.has(document.id) && <ul className="rows">{branch(document.id, depth + 1)}</ul>}
      </li>
    ));
  return (
    <div className="page">
      <PageHead
        crumbs={knowledgeCrumbs(workspace, project, "Documents")}
        title="Documents"
        switcher={<ScopeSwitch workspace={workspace} project={project} kind="documents" />}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            New Document
          </Button>
        }
      />
      <FormError error={failure} />
      {documents &&
        (documents.length === 0 ? (
          <EmptyState title="No Documents yet.">New Document starts one. Reports live with their Tickets.</EmptyState>
        ) : (
          <section aria-label="Page tree" className="panel panel-flush">
            <ul className="rows">{branch(null, 0)}</ul>
          </section>
        ))}
      <Dialog open={creating} onOpenChange={setCreating} title="New Document">
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
              Create Document
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </div>
  );
}

/** The Workspace's own page tree, separate from its Projects'. */
export function WorkspaceDocuments({ workspace }: { workspace: Workspace }) {
  return <PageTree workspace={workspace} project={null} />;
}

/** A Project's page tree. */
export function ProjectDocuments({ workspace, project }: { workspace: Workspace; project: ProjectSummary }) {
  return <PageTree workspace={workspace} project={project} />;
}

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
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [moving, setMoving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [versionsShown, setVersionsShown] = useState(0);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const otherWorkspace = useRef(onOtherWorkspace);
  otherWorkspace.current = onOtherWorkspace;
  usePlace("documents", document?.projectId ?? null);

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
  const projectId = document?.projectId ?? null;
  const ticketId = document?.ticketId ?? null;
  useEffect(() => {
    if (projectId) api.project(projectId).then(setProject, () => setProject(null));
    if (ticketId) api.ticket(ticketId).then(setTicket, () => setTicket(null));
  }, [projectId, ticketId]);
  const latestAttachments = useLatest();
  const loadAttachments = useCallback(
    () => latestAttachments(api.attachments({ kind: "document", id: documentId }), setAttachments),
    [documentId, latestAttachments],
  );
  useEffect(loadAttachments, [loadAttachments]);
  useLiveEvents(workspace.id, (event) => {
    if (event.type === "reconnected" || (event.type === "attachments.changed" && "documentId" in event && event.documentId === documentId)) {
      loadAttachments();
    }
  });

  const saved = (next: Document) => {
    setDocument(next);
    setVersionsShown((n) => n + 1);
  };

  if (failure) return <FormError error={failure} />;
  if (!document) return <p className="muted">Loading…</p>;
  const tree: Tree = document.projectId ? { kind: "project", id: document.projectId } : { kind: "workspace", id: document.workspaceId };
  // Where the Document is listed: its Ticket for a Report, otherwise its page tree.
  const home = document.ticketId ? `/tickets/${document.ticketId}` : treePage(tree);
  const crumbs = [
    workspaceCrumb(workspace),
    ...(project ? [{ label: <span className="mono">{project.key}</span>, to: `/projects/${project.id}` }] : []),
    document.ticketId
      ? { label: <span className="mono">{ticket?.key ?? "Its Ticket"}</span>, to: home }
      : { label: "Documents", to: home },
  ];
  return (
    <div className="page">
      <PageHead
        crumbs={crumbs}
        title={document.title}
        large
        meta={<VersionMeta version={document.version} />}
        actions={
          !editing && (
            <>
              <Menu label="More of this Document">
                {!document.ticketId && <MenuItem onSelect={() => setMoving(true)}>Move…</MenuItem>}
                <MenuItem tone="danger" onSelect={() => setDeleting(true)}>
                  Delete Document
                </MenuItem>
              </Menu>
              <Button variant="primary" onClick={() => setEditing(true)}>
                Edit
              </Button>
            </>
          )
        }
      />
      {editing ? (
        <Editor
          saved={document}
          save={(edit) => api.editDocument(document.id, edit)}
          attachTo={{ kind: "document", id: document.id }}
          onAttached={loadAttachments}
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
        <div className="page-split">
          <div className="page">
            <article className="panel document-body" aria-label={document.title}>
              {document.body.trim() ? (
                <div className="prose">
                  <Markdown text={document.body} mentions={[]} />
                </div>
              ) : (
                <EmptyState title="Nothing written yet.">Edit adds the first words, and saving makes a new Version.</EmptyState>
              )}
            </article>
            <Attachments
              owner={{ kind: "document", id: document.id }}
              attachments={attachments}
              label="Attachments"
              dropHint="or, while editing, drop or paste them into the Markdown"
              onChanged={loadAttachments}
            />
          </div>
          <aside className="side" aria-label="Document details">
            <Versions
              key={versionsShown}
              source={{
                list: () => api.versions(document.id),
                read: (number) => api.version(document.id, number),
                compare: (from, to) => api.compareVersions(document.id, from, to),
              }}
            />
          </aside>
        </div>
      )}
      {moving && <Move document={document} tree={tree} onMoved={setDocument} onClose={() => setMoving(false)} />}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${document.title}?`}
        confirm="Delete"
        onConfirm={async () => {
          await api.deleteDocument(document.id);
          navigate(home);
        }}
      >
        It goes with all its Versions, and can't be brought back.
      </ConfirmDialog>
    </div>
  );
}

/**
 * The Markdown source beside its preview, for a Document or a Decision. A save names the Version it's based on; one
 * based on an outdated Version is refused with the current one, shown as a Diff against the draft so its changes
 * can be folded in by hand.
 */
export function Editor<T>({
  saved,
  save,
  attachTo,
  onAttached,
  onSaved,
  onRebased,
  onCancel,
}: {
  /** What is edited, as last saved. */
  saved: { title: string; body: string; version: { number: number } };
  save: (edit: { baseVersion: number; title: string; body: string }) => Promise<T>;
  /** Where files dropped or pasted into the source are attached, if anywhere. */
  attachTo?: AttachmentOwner;
  onAttached?: () => void;
  onSaved: (next: T) => void;
  /** The draft is now based on the current Version, which the screen shows again. */
  onRebased: () => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(saved.title);
  const [body, setBody] = useState(saved.body);
  const [base, setBase] = useState(saved.version.number);
  const [current, setCurrent] = useState<VersionWithBody | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const source = useRef<HTMLTextAreaElement>(null);
  const { error, busy, onSubmit } = useSubmit(async () => {
    try {
      onSaved(await save({ baseVersion: base, title, body }));
    } catch (e) {
      if (e instanceof ApiError && e.code === "outdated_version") setCurrent(e.body.current as VersionWithBody);
      throw e;
    }
  });

  /** Attaches each file and puts a reference to it at the cursor. */
  const attachFiles = async (files: File[]) => {
    if (!attachTo || files.length === 0) return;
    setAttachError(null);
    const at = source.current?.selectionStart ?? body.length;
    try {
      const references: string[] = [];
      for (const file of files) references.push(markdownReference(await api.attach(attachTo, file)));
      setBody((text) => `${text.slice(0, at)}${references.join("\n")}${text.slice(at)}`);
      onAttached?.();
    } catch (e) {
      setAttachError(e instanceof Error ? e.message : String(e));
    }
  };
  const onDrop = (event: DragEvent<HTMLTextAreaElement>) => {
    if (!attachTo || event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    void attachFiles([...event.dataTransfer.files]);
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    // A paste carrying text pastes the text and attaches nothing.
    if (!attachTo || event.clipboardData.files.length === 0 || event.clipboardData.getData("text")) return;
    event.preventDefault();
    void attachFiles([...event.clipboardData.files]);
  };

  return (
    <form onSubmit={onSubmit} className="editor">
      {current && (
        <Banner tone="info" label="Saved meanwhile">
          <p>
            <strong>{current.actor.name}</strong> saved Version {current.number} while you were editing, so your save was
            refused. Your draft is kept: fold their changes into it, then save again.
          </p>
          <Diff from="Your draft" to={`Version ${current.number}`} lines={lineDiff(body, current.body)} label="Their changes" />
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
      <Field label="Title">
        <input value={title} required maxLength={300} onChange={(e) => setTitle(e.target.value)} className="title-input" />
      </Field>
      <div className="editor-panes">
        <Field label="Markdown" hint={attachTo ? "Drop or paste files here to attach them." : undefined}>
          <textarea
            ref={source}
            className="markdown-source"
            value={body}
            rows={20}
            onChange={(e) => setBody(e.target.value)}
            onDrop={onDrop}
            onPaste={onPaste}
          />
        </Field>
        <section aria-label="Preview" className="editor-preview">
          <span className="field-label">Preview</span>
          <div className="panel prose">
            <Markdown text={body} mentions={[]} />
          </div>
        </section>
      </div>
      <FormError error={attachError} />
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

/** Moves the Document under another parent of its page tree, or to its top, at a place among its siblings. */
function Move({
  document,
  tree,
  onMoved,
  onClose,
}: {
  document: Document;
  tree: Tree;
  onMoved: (next: Document) => void;
  onClose: () => void;
}) {
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null);
  useEffect(() => {
    api.documents(tree).then(setDocuments, () => setDocuments([]));
  }, [tree.kind, tree.id]);
  const { error, busy, onSubmit } = useSubmit(async (form) => {
    const place = field(form, "position");
    onMoved(
      await api.editDocument(document.id, {
        parentId: field(form, "parentId") || null,
        ...(place ? { position: Number(place) } : {}),
      }),
    );
    onClose();
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={`Move ${document.title}`}>
      {documents && (
        <form onSubmit={onSubmit}>
          <Field label="Parent">
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
          </Field>
          <Field label="Place among its siblings" hint="Empty puts it last.">
            <input name="position" type="number" min={0} placeholder="Last" />
          </Field>
          <FormError error={error} />
          <DialogActions>
            <DialogClose asChild>
              <Button>Cancel</Button>
            </DialogClose>
            <Button type="submit" variant="primary" disabled={busy}>
              Move
            </Button>
          </DialogActions>
        </form>
      )}
    </Dialog>
  );
}

/** Where a Document's or Decision's Versions come from. */
export interface VersionSource {
  list: () => Promise<Version[]>;
  read: (number: number) => Promise<VersionWithBody>;
  compare: (from: number, to: number) => Promise<Comparison>;
}

/** A Document's or Decision's Versions, newest first, in a side list: read any one, or pick two to see their Diff. */
export function Versions({ source }: { source: VersionSource }) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [shown, setShown] = useState<VersionWithBody | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // A new source each render is the same Versions; the screen remounts this to show a new one.
  const sourceRef = useRef(source);
  useEffect(() => {
    sourceRef.current.list().then(setVersions, (e: Error) => setFailure(e.message));
  }, []);

  const pick = (number: number, on: boolean) => {
    const next = on ? [...picked.filter((n) => n !== number), number].slice(-2) : picked.filter((n) => n !== number);
    setPicked(next);
    if (next.length === 2) {
      const [from, to] = [Math.min(...next), Math.max(...next)];
      sourceRef.current.compare(from, to).then(setComparison, (e: Error) => setFailure(e.message));
    }
  };

  if (!versions) return failure ? <FormError error={failure} /> : null;
  return (
    <section aria-label="Versions" className="panel side-section">
      <h2 className="side-title">Versions</h2>
      {versions.length > 1 && <p className="muted small">Pick two to see what changed.</p>}
      <ol className="version-list">
        {[...versions].reverse().map((version) => (
          <li key={version.number}>
            {versions.length > 1 && (
              <input
                type="checkbox"
                aria-label={`Compare Version ${version.number}`}
                checked={picked.includes(version.number)}
                onChange={(e) => pick(version.number, e.target.checked)}
              />
            )}
            <span className="version-item">
              <Button variant="ghost" size="small" onClick={() => sourceRef.current.read(version.number).then(setShown, (e: Error) => setFailure(e.message))}>
                Version {version.number}
              </Button>
              <span className="version-by">
                <Actor actor={version.actor} /> <RelativeTime at={version.savedAt} />
              </span>
            </span>
          </li>
        ))}
      </ol>
      <FormError error={failure} />
      <Dialog open={shown !== null} onOpenChange={(open) => !open && setShown(null)} title={shown ? `Version ${shown.number}: ${shown.title}` : ""} wide>
        {shown && (
          <>
            <VersionMeta version={shown} />
            <div className="panel prose">
              <Markdown text={shown.body} mentions={[]} />
            </div>
          </>
        )}
      </Dialog>
      <Dialog
        open={comparison !== null}
        onOpenChange={(open) => {
          if (!open) {
            setComparison(null);
            setPicked([]);
          }
        }}
        title="What changed"
        wide
      >
        {comparison && (
          <Diff
            from={`Version ${comparison.from.number}${comparison.from.title !== comparison.to.title ? `: ${comparison.from.title}` : ""}`}
            to={`Version ${comparison.to.number}${comparison.from.title !== comparison.to.title ? `: ${comparison.to.title}` : ""}`}
            lines={comparison.lines}
          />
        )}
      </Dialog>
    </section>
  );
}
