import { useAddresses, useCanonicalAddress } from "./addresses.js";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  api,
  ApiError,
  type Actor as ActorInfo,
  type Attachment,
  type AttachmentOwner,
  type Comparison,
  type Document,
  type DocumentSummary,
  type Mention,
  type ProjectSummary,
  type Ticket,
  type Tree,
  type Version,
  type VersionWithBody,
  type Workspace,
} from "./api.js";
import { Attachments } from "./attachments.js";
import { field, useSubmit } from "./forms.js";
import { usePlace } from "./frame.js";
import { useArrivals, useDeletedElsewhere, useLatest, useLiveEvents } from "./live.js";
import { Markdown } from "./markdown.js";
import { knowledgeCrumbs, ScopeSwitch } from "./projects.js";
import { Link, navigate } from "./router.js";
import { Actor } from "./ui/actor.js";
import { Actions, Banner, Button, DeletedElsewhere, EmptyState, Field, FormError, LiveIndicator, PageHead, Panel, RelativeTime, workspaceCrumb } from "./ui/controls.js";
import { Diff, lineDiff } from "./ui/diff.js";
import { ConfirmDialog, Dialog, DialogActions, DialogClose, Menu, MenuItem } from "./ui/overlays.js";
import { ProjectNote } from "./write-access.js";
import { RichEditor } from "./ui/lazy-rich-editor.js";

/** Nests a page tree's Documents, listed in tree order, under their parents. */
function childrenOf(documents: DocumentSummary[]): Map<string | null, DocumentSummary[]> {
  const children = new Map<string | null, DocumentSummary[]>();
  for (const document of documents) {
    children.set(document.parentId, [...(children.get(document.parentId) ?? []), document]);
  }
  return children;
}

/** Where a page tree is shown: a Project's Documents page, or the Workspace's. */

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

/**
 * A Document's, Decision's or Term's body as it reads: Markdown in a panel, 15px at a 720px measure. The read view, a
 * Term editor's preview and a Version's dialog all draw it this way; the rich editor edits at the same size.
 */
export function DocumentBody({
  body,
  mentions = [],
  label,
  empty,
  after,
}: {
  body: string;
  /** The Ticket keys it mentions, linked; only the current Version's are known, so a past Version's are plain text. */
  mentions?: Mention[];
  label?: string;
  empty?: ReactNode;
  /** What follows the body at the same measure, such as a Term's words to avoid. */
  after?: ReactNode;
}) {
  const content =
    empty && !body.trim() ? (
      empty
    ) : (
      <div className="prose">
        <Markdown text={body} mentions={mentions} />
        {after}
      </div>
    );
  return label ? (
    <article className="panel document-body" aria-label={label}>
      {content}
    </article>
  ) : (
    <div className="panel document-body">{content}</div>
  );
}

/** A page tree's Documents, nested, under a page head with the scope dropdown and New Document. */
function PageTree({ workspace, project }: { workspace: Workspace; project: ProjectSummary | null }) {
  const to = useAddresses();
  const tree: Tree = project ? { kind: "project", id: project.id } : { kind: "workspace", id: workspace.id };
  usePlace("documents", project?.id ?? null);
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const latest = useLatest();
  const load = useCallback(
    () => latest(api.documents(tree), setDocuments, (e) => setFailure(e.message)),
    [tree.kind, tree.id, latest],
  );
  useEffect(load, [load]);
  useLiveEvents(workspace.id, (event) => {
    if (event.type === "reconnected" || (event.type === "document.changed" && event.projectId === (project?.id ?? null))) load();
  });
  const arrived = useArrivals(documents?.map((d) => d.id) ?? [], documents !== null);

  const { error, busy, onSubmit } = useSubmit(async (form) => {
    const created = await api.createDocument(tree, { title: field(form, "title") });
    navigate(to.document(created));
  });

  const children = documents ? childrenOf(documents) : new Map<string | null, DocumentSummary[]>();
  const branch = (parentId: string | null, depth: number): ReactNode =>
    (children.get(parentId) ?? []).map((document) => (
      <li key={document.id}>
        <Link to={to.document(document)} className={`row tree-row${arrived.has(document.id) ? " arrived" : ""}`} style={{ "--depth": depth } as CSSProperties}>
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
        switcher={
          <>
            <LiveIndicator workspaceId={workspace.id} />
            <ScopeSwitch workspace={workspace} project={project} kind="documents" />
          </>
        }
        actions={
          // With Read in the Project, its page tree offers no New Document.
          (!project || project.access === "write") && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              New Document
            </Button>
          )
        }
      />
      {project && <ProjectNote project={project} />}
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
 * A Document: read it, edit it in the rich editor, move it in its page tree, and browse its Versions. A
 * Report is listed with its Ticket instead, so it leads back there and doesn't move.
 */
export function DocumentScreen({
  workspace,
  documentId,
}: {
  workspace: Workspace;
  documentId: string;
}) {
  const to = useAddresses();
  const [document, setDocument] = useState<Document | null>(null);
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [moving, setMoving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [versionsShown, setVersionsShown] = useState(0);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const { gone, failed, deleteHere } = useDeletedElsewhere();
  usePlace("documents", document?.projectId ?? null);

  const load = useCallback(() => {
    api.document(documentId).then(
      (found) => {
        if (found.workspaceId === workspace.id) setDocument(found);
        else setFailure("No such Document.");
      },
      (e: Error) => setFailure(e.message),
    );
  }, [documentId, workspace.id]);
  useEffect(load, [load]);
  const latestDocument = useLatest();
  /** Fetches the shown Document again after a live event, keeping it on screen if it went meanwhile. */
  const reload = useCallback(
    () =>
      latestDocument(api.document(documentId), setDocument, failed),
    [documentId, latestDocument, failed],
  );
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
    if (
      event.type === "reconnected" ||
      (event.type === "document.changed" && event.documentId === documentId) ||
      (event.type === "report.changed" && event.reportId === documentId)
    ) {
      reload();
    }
  });

  const saved = (next: Document) => {
    setDocument(next);
    setVersionsShown((n) => n + 1);
  };

  useCanonicalAddress(document && !gone ? to.document(document) : null);

  if (failure) return <FormError error={failure} />;
  if (!document) return <p className="muted">Loading…</p>;
  // With Read in its Project, the Document is only read: no Edit, Move or Delete, and no attaching.
  const canWrite = !project || project.access === "write";
  const tree: Tree = document.projectId ? { kind: "project", id: document.projectId } : { kind: "workspace", id: document.workspaceId };
  // Where the Document is listed: its Ticket for a Report, otherwise its page tree.
  const home = document.ticketId ? (ticket ? to.ticket(ticket) : `/tickets/${document.ticketId}`) : to.place(tree, "documents");
  const crumbs = [
    workspaceCrumb(workspace),
    ...(project ? [{ label: <span className="mono">{project.key}</span>, to: to.project(project) }] : []),
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
        switcher={<LiveIndicator workspaceId={workspace.id} />}
        meta={<VersionMeta version={document.version} />}
        actions={
          !editing &&
          !gone &&
          canWrite && (
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
      {project && <ProjectNote project={project} />}
      {gone && (
        <DeletedElsewhere back={{ to: home, label: document.ticketId ? "Back to its Ticket" : "Back to Documents" }}>
          this Document is no longer kept.
        </DeletedElsewhere>
      )}
      {editing && canWrite ? (
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
            <DocumentBody
              body={document.body}
              mentions={document.mentions}
              label={document.title}
              empty={
                <EmptyState title="Nothing written yet.">
                  {canWrite ? "Edit adds the first words, and saving makes a new Version." : null}
                </EmptyState>
              }
            />
            <Attachments
              owner={{ kind: "document", id: document.id }}
              attachments={attachments}
              label="Attachments"
              canAttach={canWrite}
              dropHint="or, while editing, drop or paste them into the text"
              onChanged={loadAttachments}
            />
          </div>
          <aside className="side" aria-label="Document details">
            <Versions
              key={versionsShown}
              current={document.version.number}
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
          await deleteHere(() => api.deleteDocument(document.id));
          navigate(home);
        }}
      >
        It goes with all its Versions, and can't be brought back.
      </ConfirmDialog>
    </div>
  );
}

/**
 * The title and the rich editor, for a Document or a Decision. A save names the Version it's based on; one
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
  /** Where files dropped or pasted into the text are attached, if anywhere. */
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
  const { error, busy, onSubmit } = useSubmit(async () => {
    try {
      onSaved(await save({ baseVersion: base, title, body }));
    } catch (e) {
      if (e instanceof ApiError && e.code === "outdated_version") setCurrent(e.body.current as VersionWithBody);
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
      <RichEditor
        value={body}
        onChange={setBody}
        hint={attachTo ? "Drop or paste files here to attach them." : undefined}
        attachTo={attachTo}
        onAttached={onAttached}
      />
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

/** A Version as a list of Versions shows it: its number, and who saved it and when. */
type ListedVersion = Pick<Version, "number" | "actor" | "savedAt">;

/**
 * Where a Document's, Decision's, Term's or Artifact's Versions come from. Each Document's, Decision's or Term's is
 * read with a title and a body, and compares as a Diff of them; an Artifact's are only compared, file by file.
 */
export interface VersionSource<V extends VersionWithBody = VersionWithBody, C = Comparison<V>> {
  list: () => Promise<ListedVersion[]>;
  /** Reads one Version; its list entries open nothing when left out. */
  read?: (number: number) => Promise<V>;
  compare: (from: number, to: number) => Promise<C>;
  /** Draws a Version read alone; its body as a Document's when left out. */
  show?: (version: V) => ReactNode;
  /** Draws what changed between two; a Diff of their bodies, named by their titles where they differ, when left out. */
  showComparison?: (comparison: C) => ReactNode;
}

/** Two Versions' bodies as a Diff, named by Version and, where they differ, by title. */
function BodiesCompared({ comparison }: { comparison: Comparison }) {
  const { from, to } = comparison;
  const titled = (version: Version) => `Version ${version.number}${from.title !== to.title ? `: ${version.title}` : ""}`;
  return <Diff from={titled(from)} to={titled(to)} lines={comparison.lines} />;
}

/**
 * A Document's, Decision's, Term's or Artifact's Versions, newest first, in a side list, each with who saved it and
 * when: read any one, or pick two to see what changed. A new current Version, such as one saved elsewhere, joins the
 * list in place, leaving whatever is open and picked as it is.
 */
export function Versions<V extends VersionWithBody, C = Comparison<V>>({
  source,
  current,
  revision,
  deleting,
}: {
  source: VersionSource<V, C>;
  /** The current Version's number; the list is read again when it changes. */
  current: number;
  /** Changes when the Versions may have changed other than by a new current one, such as one deleted elsewhere. */
  revision?: number;
  /** Offers to delete each Version, in its own "…" menu, while more than one is left; left out, none is offered. */
  deleting?: {
    run: (number: number) => Promise<void>;
    /** What deleting a Version does, said when asking first. */
    note: ReactNode;
  };
}) {
  const [versions, setVersions] = useState<ListedVersion[] | null>(null);
  const [shown, setShown] = useState<V | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [comparison, setComparison] = useState<C | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // Kept apart from the others so the next list read clears it.
  const [listFailure, setListFailure] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<number | null>(null);
  // Bumped after a delete here, so the list is read again.
  const [deleted, setDeleted] = useState(0);
  const latest = useLatest();
  const latestList = useLatest();
  // A new source each render reads the same Versions; the latest one is used.
  const sourceRef = useRef(source);
  sourceRef.current = source;
  useEffect(() => {
    // Lists read quickly one after another show only the last, however the replies arrive.
    latestList(
      sourceRef.current.list(),
      (listed) => {
        setVersions(listed);
        setListFailure(null);
      },
      (e) => setListFailure(e.message),
    );
  }, [current, revision, deleted, latestList]);
  // A Version that went drops out of the picks.
  useEffect(() => {
    if (versions) setPicked((picks) => picks.filter((n) => versions.some((version) => version.number === n)));
  }, [versions]);

  const pick = (number: number, on: boolean) => {
    const next = on ? [...picked.filter((n) => n !== number), number].slice(-2) : picked.filter((n) => n !== number);
    setPicked(next);
    if (next.length === 2) {
      const [from, to] = [Math.min(...next), Math.max(...next)];
      // Picks changed quickly show only the last two's comparison, however the replies arrive.
      latest(sourceRef.current.compare(from, to), setComparison, (e) => setFailure(e.message));
    }
  };
  const { read, show, showComparison } = sourceRef.current;
  const arrived = useArrivals(versions?.map((version) => String(version.number)) ?? [], versions !== null);

  if (!versions) return listFailure ? <FormError error={listFailure} /> : null;
  return (
    <section aria-label="Versions" className="panel side-section">
      <h2 className="side-title">Versions</h2>
      {versions.length > 1 && <p className="muted small">Pick two to see what changed.</p>}
      <ol className="version-list">
        {[...versions].reverse().map((version) => (
          <li key={version.number} className={arrived.has(String(version.number)) ? "arrived" : undefined}>
            {versions.length > 1 && (
              <input
                type="checkbox"
                aria-label={`Compare Version ${version.number}`}
                checked={picked.includes(version.number)}
                onChange={(e) => pick(version.number, e.target.checked)}
              />
            )}
            <span className="version-item">
              {read ? (
                <Button variant="ghost" size="small" onClick={() => read(version.number).then(setShown, (e: Error) => setFailure(e.message))}>
                  Version {version.number}
                </Button>
              ) : (
                <span>Version {version.number}</span>
              )}
              <span className="version-by">
                <Actor actor={version.actor} /> <RelativeTime at={version.savedAt} />
              </span>
            </span>
            {deleting && versions.length > 1 && (
              <span className="version-actions">
                <Menu
                  label={`More of Version ${version.number}`}
                  trigger={
                    <Button variant="ghost" size="small" aria-label={`More of Version ${version.number}`} title={`More of Version ${version.number}`}>
                      …
                    </Button>
                  }
                >
                  <MenuItem tone="danger" onSelect={() => setToDelete(version.number)}>
                    Delete Version
                  </MenuItem>
                </Menu>
              </span>
            )}
          </li>
        ))}
      </ol>
      <FormError error={failure ?? listFailure} />
      {deleting && (
        <ConfirmDialog
          open={toDelete !== null}
          onOpenChange={(open) => !open && setToDelete(null)}
          title={`Delete Version ${toDelete ?? ""}?`}
          confirm="Delete"
          onConfirm={async () => {
            if (toDelete === null) return;
            await deleting.run(toDelete);
            setToDelete(null);
            setDeleted((n) => n + 1);
          }}
        >
          {deleting.note}
        </ConfirmDialog>
      )}
      <Dialog open={shown !== null} onOpenChange={(open) => !open && setShown(null)} title={shown ? `Version ${shown.number}: ${shown.title}` : ""} wide>
        {shown && (
          <>
            <VersionMeta version={shown} />
            {show ? show(shown) : <DocumentBody body={shown.body} />}
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
        {comparison !== null &&
          // Left out only where the comparison is a Comparison, the default.
          (showComparison ? showComparison(comparison) : <BodiesCompared comparison={comparison as unknown as Comparison} />)}
      </Dialog>
    </section>
  );
}
