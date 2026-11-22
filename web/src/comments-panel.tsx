import { useCallback, useEffect, useState } from "react";
import { api, type Comment, type User, type Workspace } from "./api.js";
import { useArrivals, useLatest, useLiveEvents, type StreamEvent } from "./live.js";
import { CommentForm, CommentThread } from "./tickets.js";
import { Avatar } from "./ui/actor.js";
import { FormError } from "./ui/controls.js";
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
    // A Comment added, or a file attached to or removed from one of them, names only the Document.
    changed: (event: StreamEvent, id: string) =>
      (event.type === "comment.added" || event.type === "attachments.changed") && "documentId" in event && event.documentId === id,
  },
} satisfies Record<CommentTarget["kind"], unknown>;

/**
 * The Comments on an Artifact or a Document, oldest first, each with its replies and Attachments, and the Comment
 * box, left out without Write; they update live.
 */
export function CommentsPanel({ workspace, target, user }: { workspace: Workspace; target: CommentTarget; user: User }) {
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const canWrite = useCanWrite();
  const latest = useLatest();
  const source = sources[target.kind];
  const load = useCallback(
    () => latest(source.list(target.id), setComments, (e) => setFailure(e.message)),
    [source, target.id, latest],
  );
  useEffect(load, [load]);
  useLiveEvents(workspace.id, (event) => {
    if (event.type === "reconnected" || source.changed(event, target.id)) load();
  });
  const shown = comments ?? [];
  const arrived = useArrivals(shown.map((c) => `comment:${c.id}`), comments !== null);
  // The live refetch may have shown the new Comment already.
  const added = (comment: Comment) =>
    setComments((list) => ((list ?? []).some((c) => c.id === comment.id) ? list : [...(list ?? []), comment]));
  const threads = shown.filter((c) => c.replyToId === null);
  return (
    <section aria-label="Comments" className="comments-panel">
      <h2>Comments</h2>
      <FormError error={failure} />
      {comments && threads.length === 0 && <p className="muted">No Comments yet.</p>}
      {threads.length > 0 && (
        <ol className="comments-panel-list">
          {threads.map((comment) => (
            <li key={comment.id} className="entry">
              <span className="gutter">
                <Avatar actor={comment.actor} />
              </span>
              <CommentThread
                comment={comment}
                comments={shown}
                ticket={null}
                user={user}
                runs={[]}
                depth={0}
                arrived={arrived}
                onAdded={added}
                onChanged={load}
              />
            </li>
          ))}
        </ol>
      )}
      {canWrite && (
        <CommentForm
          label="New Comment"
          button="Comment"
          placeholder="Comment… Ticket keys link to their Tickets"
          onSend={async (body) => added(await source.post(target.id, { body }))}
        />
      )}
    </section>
  );
}
