import { useCallback, useEffect, useState } from "react";
import { api, type Comment, type User, type Workspace } from "./api.js";
import { useArrivals, useLatest, useLiveEvents, type StreamEvent } from "./live.js";
import { CommentForm, CommentThread } from "./tickets.js";
import { Avatar } from "./ui/actor.js";
import { Button, FormError } from "./ui/controls.js";
import { useCanWrite } from "./write-access.js";

/** What a Comments panel is under: an Artifact, or a Document (a Report included). */
export type CommentTarget = { kind: "artifact" | "document"; id: string };

const sources = {
  artifact: {
    list: api.artifactComments,
    post: api.commentOnArtifact,
    changed: (event: StreamEvent, id: string) => event.type === "artifact.comments.changed" && event.artifactId === id,
  },
  document: {
    list: api.documentComments,
    post: api.commentOnDocument,
    // A Comment added or a thread resolved, or a file attached to or removed from one of them, names only the
    // Document; a save of the Document moves its quoted threads, or leaves them outdated.
    changed: (event: StreamEvent, id: string) =>
      (event.type === "comment.added" ||
        event.type === "comment.changed" ||
        event.type === "attachments.changed" ||
        event.type === "document.changed") &&
      "documentId" in event &&
      event.documentId === id,
  },
} satisfies Record<CommentTarget["kind"], unknown>;

/** The Comments on an Artifact or a Document, oldest first, kept up to date live. */
export interface Comments {
  /** Null until they first load. */
  list: Comment[] | null;
  failure: string | null;
  /** Which Comments arrived since the page loaded, for the short accent ring. */
  arrived: Set<string>;
  load: () => void;
  /** Shows a Comment just placed, unless the live refetch already did. */
  added: (comment: Comment) => void;
  /** How many threads are resolved; a Document's only, as only they resolve. */
  resolvedCount: number;
  /** Whether resolved threads show, in their places, until the page is left or none is resolved. */
  showResolved: boolean;
  setShowResolved: (show: boolean) => void;
  /** Whether a thread shows: open, or resolved while resolved ones are shown. */
  isShown: (thread: Comment) => boolean;
  /** Resolves or unresolves a thread on a Document; left out on an Artifact. */
  resolve?: (thread: Comment, resolved: boolean) => Promise<void>;
}

export function useComments(workspace: Workspace, target: CommentTarget): Comments {
  const [list, setList] = useState<Comment[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const latest = useLatest();
  const source = sources[target.kind];
  const load = useCallback(
    () => latest(source.list(target.id), setList, (e) => setFailure(e.message)),
    [source, target.id, latest],
  );
  useEffect(load, [load]);
  useLiveEvents(workspace.id, (event) => {
    if (event.type === "reconnected" || source.changed(event, target.id)) load();
  });
  const arrived = useArrivals((list ?? []).map((c) => `comment:${c.id}`), list !== null);
  const added = useCallback(
    (comment: Comment) => setList((now) => ((now ?? []).some((c) => c.id === comment.id) ? now : [...(now ?? []), comment])),
    [],
  );
  const [showResolved, setShowResolved] = useState(false);
  const resolvedCount = (list ?? []).filter((c) => c.replyToId === null && c.resolved !== null).length;
  // With the last resolved thread unresolved, the next one resolved hides again.
  useEffect(() => {
    if (resolvedCount === 0) setShowResolved(false);
  }, [resolvedCount]);
  const isShown = useCallback((thread: Comment) => showResolved || thread.resolved === null, [showResolved]);
  // The Comment comes back with its new state, before the live refetch.
  const resolve = useCallback(async (thread: Comment, resolved: boolean) => {
    setFailure(null);
    try {
      const updated = await (resolved ? api.resolveComment(thread.id) : api.unresolveComment(thread.id));
      setList((now) => (now ?? []).map((c) => (c.id === updated.id ? updated : c)));
    } catch (e) {
      setFailure((e as Error).message);
    }
  }, []);
  return {
    list,
    failure,
    arrived,
    load,
    added,
    resolvedCount,
    showResolved,
    setShowResolved,
    isShown,
    resolve: target.kind === "document" ? resolve : undefined,
  };
}

/** A thread placed beside its passage in its Document's text: those whose quote is still there. */
export const placed = (comment: Comment): comment is Comment & { anchor: { offset: number } } =>
  comment.replyToId === null && comment.anchor !== null && comment.anchor !== "outdated";

/** A thread: its first Comment, with its avatar in the gutter, and its replies under it. */
export function ThreadEntry({ comment, comments, user }: { comment: Comment; comments: Comments; user: User }) {
  const canWrite = useCanWrite();
  const resolve = comments.resolve;
  return (
    <li className="entry">
      <span className="gutter">
        <Avatar actor={comment.actor} />
      </span>
      <div className="thread-body">
        {comment.quote !== null && (
          <blockquote className="comment-quote" aria-label="Quoted passage">
            {comment.quote}
            {comment.anchor === "outdated" && (
              <span className="comment-quote-note">Written on Version {comment.quoteVersion}; no longer in the Document.</span>
            )}
          </blockquote>
        )}
        <CommentThread
          comment={comment}
          comments={comments.list ?? []}
          ticket={null}
          user={user}
          runs={[]}
          depth={0}
          arrived={comments.arrived}
          onAdded={comments.added}
          onChanged={comments.load}
          onResolve={resolve && canWrite ? (resolved) => resolve(comment, resolved) : undefined}
        />
      </div>
    </li>
  );
}

/**
 * The Comments on an Artifact or a Document, oldest first, each with its replies and Attachments, and the Comment
 * box, left out without Write, as `useComments` keeps them. On a Document, threads placed beside their passage are left out
 * here, and outdated ones lead.
 */
export function CommentsPanel({ target, user, comments }: { target: CommentTarget; user: User; comments: Comments }) {
  const canWrite = useCanWrite();
  const shown = comments.list ?? [];
  const threads = shown.filter((c) => c.replyToId === null);
  const outdated = threads.filter((c) => c.anchor === "outdated");
  const listed = [...outdated, ...threads.filter((c) => c.anchor === null)].filter(comments.isShown);
  const { resolvedCount, showResolved, setShowResolved } = comments;
  return (
    <section aria-label="Comments" className="comments-panel">
      <h2>Comments</h2>
      <FormError error={comments.failure} />
      {resolvedCount > 0 && (
        <Button variant="ghost" size="small" aria-pressed={showResolved} onClick={() => setShowResolved(!showResolved)}>
          {showResolved ? "Hide resolved" : `Show resolved (${resolvedCount})`}
        </Button>
      )}
      {comments.list && threads.length === 0 && <p className="muted">No Comments yet.</p>}
      {comments.list && threads.length > 0 && resolvedCount === threads.length && !showResolved && (
        <p className="muted">No open Comments.</p>
      )}
      {listed.length > 0 && (
        <ol className="comments-panel-list">
          {listed.map((comment) => (
            <ThreadEntry key={comment.id} comment={comment} comments={comments} user={user} />
          ))}
        </ol>
      )}
      {canWrite && (
        <CommentForm
          label="New Comment"
          button="Comment"
          placeholder="Comment… Ticket keys link to their Tickets"
          onSend={async (body) => comments.added(await sources[target.kind].post(target.id, { body }))}
        />
      )}
    </section>
  );
}
