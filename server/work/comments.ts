import { Type, type Static } from "typebox";
import { Attachment, attachmentsOnComments } from "../attachments/attachments.js";
import type { Context } from "../context.js";
import { transaction, type Db, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import type { Caller } from "../identity/callers.js";
import { inReach, requireWrite, type Viewer } from "../identity/viewers.js";
import { requireHumanAct } from "../identity/acts.js";
import { answerQuestion } from "../runs/questions.js";
import { insertComment } from "./comment-writes.js";
import { Actor, ActorOrCronk, actorColumn, actorOrCronkColumn } from "./actors.js";
import { findTicketRow, ticketNotFound } from "./tickets.js";
import { Mention, mentionsOf } from "./mentions.js";
import { slugColumn } from "../http/readable.js";
import { artifactNotFound, findArtifact } from "../artifacts/artifacts.js";
import { insertArtifactComment, insertDocumentComment } from "./comment-writes.js";
import { documentNotFound, findDocument } from "../knowledge/documents.js";
import { ownerName } from "../agents/tokens.js";

/** The Artifact a Comment is on, as a Ticket's timeline marks it. */
export const CommentArtifact = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    projectId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
    title: Type.String({ description: "Its current title." }),
    slug: Type.String(),
  },
  { description: "The Artifact the Comment is on; null for a Comment on a Ticket or a Document." },
);

/** The Document a Comment is on, a Report included. */
export const CommentDocument = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    projectId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
    title: Type.String({ description: "Its current title." }),
    slug: Type.String(),
  },
  { description: "The Document the Comment is on; null for a Comment on a Ticket or an Artifact." },
);
import { markdown } from "./fields.js";

/** A resolved thread on a Document: when, and the User who resolved it. */
export const CommentResolution = Type.Object(
  {
    at: Type.String({ format: "date-time" }),
    by: Actor,
  },
  { description: "A resolved thread: when, and by which User. Only Users resolve threads." },
);
export type CommentResolution = Static<typeof CommentResolution>;

/** The author of a Comment imported from a GitHub issue whom no User of the Workspace has linked. */
export const GitHubAuthor = Type.Object(
  {
    kind: Type.Literal("github"),
    login: Type.String({ description: "Their GitHub login." }),
    name: Type.String({ description: "How to show them: `@login on GitHub`." }),
  },
  { description: "A GitHub account no User has linked, which wrote an imported Comment." },
);
export type GitHubAuthor = Static<typeof GitHubAuthor>;

/** Where a quoted thread sits in its Document's current Version. */
export const CommentAnchor = Type.Object(
  {
    offset: Type.Integer({
      minimum: 0,
      description:
        "Where the quote first appears in the current Version's Markdown, in UTF-16 code units, after normalising its " +
        "line endings to `\\n`.",
    }),
  },
  { description: "Where the quote sits in the current Version." },
);

/** Text with its line endings, `\r\n` and `\r`, made `\n`: how quotes are matched. */
export function normaliseLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export const Comment = Type.Object({
  id: Type.String({ format: "uuid" }),
  ticketId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
    description: "The Ticket it is on; null for a Comment on an Artifact or a Document.",
  }),
  artifactId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
    description:
      "The Artifact it is on; null for a Comment on a Ticket or a Document. A Ticket's Comments include those on its Linked " +
      "Artifacts, each naming its Artifact here and in `artifact`; replies to one go to the Artifact.",
  }),
  artifact: Type.Union([CommentArtifact, Type.Null()]),
  documentId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
    description: "The Document it is on, a Report included; null for a Comment on a Ticket or an Artifact.",
  }),
  document: Type.Union([CommentDocument, Type.Null()]),
  replyToId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
  body: Type.String({ description: "Markdown." }),
  actor: Type.Union([...ActorOrCronk.anyOf, GitHubAuthor], {
    description: "Who wrote it: a User, an Agent, Cronk itself, or for a Comment imported from GitHub, its author's GitHub account when no User has linked it.",
  }),
  createdAt: Type.String({ format: "date-time" }),
  mentions: Type.Array(Mention, {
    description: "The Ticket and Decision keys and Term names its body mentions and the Artifacts it embeds that the caller may read.",
  }),
  attachments: Type.Array(Attachment, { description: "The files attached to the Comment, oldest first." }),
  questionId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
    description: "The Question this Comment asks, if a Run asked one with it; the first User's reply answers it.",
  }),
  sentBack: Type.Boolean({
    description: "Whether this is Cronk's Comment on a send-back, linking the failing check or the review requesting changes.",
  }),
  resolved: Type.Union([CommentResolution, Type.Null()], {
    description:
      "When and by whom the thread this Comment starts on a Document was resolved; null for an open thread, a reply, or " +
      "a Comment on a Ticket or an Artifact.",
  }),
  quote: Type.Union([Type.String(), Type.Null()], {
    description:
      "The passage of its Document the Comment's thread is on, as Markdown of the Version it was written on; null for a " +
      "Comment on the whole Document, a reply, or a Comment on a Ticket or an Artifact.",
  }),
  quoteVersion: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()], {
    description: "The number of the Version its `quote` was taken from; null without a quote.",
  }),
  anchor: Type.Union([CommentAnchor, Type.Literal("outdated"), Type.Null()], {
    description:
      "Where the quote sits in the Document's current Markdown: the offset of its first appearance, or `outdated` once " +
      "it no longer appears; null without a quote.",
  }),
});
export type Comment = Static<typeof Comment>;

type Row = Omit<Comment, "createdAt" | "mentions" | "attachments" | "resolved" | "anchor"> & {
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedBy: Actor | null;
};

const columns = `comments.id, comments.ticket_id as "ticketId", comments.artifact_id as "artifactId",
  case when artifacts.id is null then null else json_build_object('id', artifacts.id, 'projectId', artifacts.project_id,
    'title', artifact_versions.title, 'slug', ${slugColumn("artifact", "artifacts.id", "artifact_versions.title")}) end as artifact,
  comments.document_id as "documentId",
  case when documents.id is null then null else json_build_object('id', documents.id, 'projectId', documents.project_id,
    'title', document_versions.title, 'slug', ${slugColumn("document", "documents.id", "document_versions.title")}) end as document,
  comments.reply_to_id as "replyToId", comments.body,
  case when comments.github_author_login is not null then json_build_object('kind', 'github',
    'login', comments.github_author_login, 'name', '@' || comments.github_author_login || ' on GitHub')
    else ${actorOrCronkColumn("users", "agents")} end as actor, comments.created_at as "createdAt", questions.id as "questionId",
  comments.sent_back as "sentBack", comments.quote, comments.quote_version as "quoteVersion",
  comments.resolved_at as "resolvedAt",
  case when resolvers.id is null then null else ${actorColumn("resolvers")} end as "resolvedBy"`;

const fromComments = `comments
  left join users on users.id = comments.actor_user_id
  left join agents on agents.id = comments.actor_agent_id
  left join users resolvers on resolvers.id = comments.resolved_by_user_id
  left join questions on questions.comment_id = comments.id
  left join artifacts on artifacts.id = comments.artifact_id
  left join artifact_versions on artifact_versions.artifact_id = artifacts.id and artifact_versions.number = artifacts.version
  left join documents on documents.id = comments.document_id
  left join document_versions on document_versions.document_id = documents.id and document_versions.number = documents.version`;

/**
 * The Ticket's Comments, oldest first, with those on its Reports and on its Linked Artifacts the Viewer can read
 * among them; or only the one given. Comments on its other Linked Documents stay with those Documents.
 */
async function rowsOf(db: Db | Tx, viewer: Viewer, ticketId: string, commentId?: string): Promise<Row[]> {
  const reach = inReach(viewer, { project: "artifacts.project_id", workspace: "artifacts.workspace_id" }, "$2");
  const { rows } = await db.query<Row>(
    `select ${columns} from ${fromComments}
     where (comments.ticket_id = $1
       or comments.document_id in (select reports.id from documents reports where reports.ticket_id = $1)
       or (comments.artifact_id in
       (select linked_artifacts.artifact_id from linked_artifacts where linked_artifacts.ticket_id = $1) and ${reach.sql}))
       ${commentId ? "and comments.id = $3" : ""}
     order by comments.seq`,
    commentId ? [ticketId, reach.value, commentId] : [ticketId, reach.value],
  );
  return rows;
}

/** The Artifact's Comments, oldest first; or only the one given. */
async function artifactRowsOf(db: Db | Tx, artifactId: string, commentId?: string): Promise<Row[]> {
  const { rows } = await db.query<Row>(
    `select ${columns} from ${fromComments}
     where comments.artifact_id = $1 ${commentId ? "and comments.id = $2" : ""}
     order by comments.seq`,
    commentId ? [artifactId, commentId] : [artifactId],
  );
  return rows;
}

/** The Document's Comments, oldest first; or only the one given. */
async function documentRowsOf(db: Db | Tx, documentId: string, commentId?: string): Promise<Row[]> {
  const { rows } = await db.query<Row>(
    `select ${columns} from ${fromComments}
     where comments.document_id = $1 ${commentId ? "and comments.id = $2" : ""}
     order by comments.seq`,
    commentId ? [documentId, commentId] : [documentId],
  );
  return rows;
}

/**
 * Comments as the API shows them, finding the Ticket keys of all their bodies, and their Attachments, at once. A
 * quoted Comment is placed in `body`, its Document's current Markdown; Comments on Tickets and Artifacts quote nothing.
 */
async function present(db: Db | Tx, viewer: Viewer, rows: Row[], body?: string): Promise<Comment[]> {
  const mentions = await mentionsOf(db, viewer, "comment", rows.map((row) => row.id));
  const attachments = await attachmentsOnComments(db, rows.map((row) => row.id));
  const current = body === undefined ? undefined : normaliseLineEndings(body);
  return rows.map(({ resolvedAt, resolvedBy, ...row }) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    mentions: mentions.get(row.id)!,
    attachments: attachments.get(row.id)!,
    resolved: resolvedAt && resolvedBy ? { at: resolvedAt.toISOString(), by: resolvedBy } : null,
    anchor: row.quote === null || current === undefined ? null : anchorIn(current, row.quote),
  }));
}

/** Where the quote first appears in the normalised Markdown, or `outdated` when it no longer does. */
function anchorIn(markdown: string, quote: string): Comment["anchor"] {
  const offset = markdown.indexOf(quote);
  return offset === -1 ? "outdated" : { offset };
}

export async function commentsOn(db: Db, viewer: Viewer, ticketId: string): Promise<Comment[]> {
  const ticket = await findTicketRow(db, viewer, ticketId);
  if (!ticket) throw ticketNotFound();
  return present(db, viewer, await rowsOf(db, viewer, ticket.id));
}

/** The comment route's body: a Comment, or a reply to one. */
export const CommentCreate = Type.Object({
  body: markdown(100_000),
  replyToId: Type.Optional(Type.String({ description: "The id of the Comment on this Ticket, Artifact or Document being replied to." })),
});
export type CommentCreate = Static<typeof CommentCreate>;

/** The Document comment route's body: a Comment, on the whole Document or a passage it quotes, or a reply to one. */
export const DocumentCommentCreate = Type.Object({
  ...CommentCreate.properties,
  quote: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 100_000,
      description:
        "A passage of the Document's current Version the Comment is on, as its Markdown, matched exactly after " +
        "normalising line endings. Left out, the Comment is on the whole Document. A reply takes none: it is on " +
        "its thread's passage.",
    }),
  ),
});
export type DocumentCommentCreate = Static<typeof DocumentCommentCreate>;

export async function addComment(
  context: Context,
  actor: Caller,
  ticketId: string,
  input: CommentCreate,
): Promise<Comment> {
  return transaction(context.db, async (tx) => {
    // A reply may answer a Question, moving the Ticket, so it locks the Ticket as moves do.
    const ticket = await findTicketRow(tx, actor, ticketId, { lock: input.replyToId !== undefined });
    if (!ticket) throw ticketNotFound();
    await requireWrite(tx, actor, ticket);
    if (input.replyToId !== undefined) {
      const { rowCount } = isUuid(input.replyToId)
        ? await tx.query("select 1 from comments where id = $1 and ticket_id = $2", [input.replyToId, ticket.id])
        : { rowCount: 0 };
      if (rowCount === 0) throw unknownReplyTarget("Ticket");
    }
    const commentId = await insertComment(context, tx, ticket, actor, input.body, input.replyToId ?? null);
    if (actor.kind === "user" && input.replyToId !== undefined) {
      await answerQuestion(context, tx, ticket, actor.id, input.replyToId, commentId);
    }
    const [comment] = await present(tx, actor, await rowsOf(tx, actor, ticket.id, commentId));
    return comment!;
  });
}

function unknownReplyTarget(on: "Ticket" | "Artifact" | "Document"): ApiError {
  return new ApiError(400, "unknown_comment", `Replies go to a Comment on the same ${on}.`, {
    rule: `A reply answers a Comment on the ${on} it is written on.`,
    advice:
      on === "Ticket"
        ? "Reply to a Comment on an Artifact through the Artifact, as its Comment names it, or comment without `replyToId`."
        : `Name a Comment of this ${on} as \`replyToId\`, or comment without it.`,
  });
}

/** The Artifact's Comments, oldest first, for a Viewer who can read it. */
export async function commentsOnArtifact(db: Db, viewer: Viewer, artifactId: string): Promise<Comment[]> {
  const artifact = await findArtifact(db, viewer, artifactId);
  if (!artifact) throw artifactNotFound();
  return present(db, viewer, await artifactRowsOf(db, artifact.id));
}

/**
 * Comments on an Artifact, or replies to one of its Comments, as the Actor: with Write where the Artifact is kept, as
 * on a Ticket. It shows on the Tickets linking the Artifact too.
 */
export async function addArtifactComment(
  context: Context,
  actor: Caller,
  artifactId: string,
  input: CommentCreate,
): Promise<Comment> {
  return transaction(context.db, async (tx) => {
    const artifact = await findArtifact(tx, actor, artifactId);
    if (!artifact) throw artifactNotFound();
    await requireWrite(tx, actor, artifact);
    // Held until the Comment is in, so a delete of the Artifact either went first, and it is unknown, or waits.
    await tx.query("select 1 from artifacts where id = $1 for key share", [artifact.id]);
    if (input.replyToId !== undefined) {
      const { rowCount } = isUuid(input.replyToId)
        ? await tx.query("select 1 from comments where id = $1 and artifact_id = $2", [input.replyToId, artifact.id])
        : { rowCount: 0 };
      if (rowCount === 0) throw unknownReplyTarget("Artifact");
    }
    const commentId = await insertArtifactComment(context, tx, artifact, actor, input.body, input.replyToId ?? null);
    const [comment] = await present(tx, actor, await artifactRowsOf(tx, artifact.id, commentId));
    return comment!;
  });
}

/**
 * The Document's Comments, oldest first, for a Viewer who can read it; a Report's included. A resolved thread is left
 * out, its replies with it, unless `includeResolved` asks for it.
 */
export async function commentsOnDocument(
  db: Db | Tx,
  viewer: Viewer,
  documentId: string,
  { includeResolved = false }: { includeResolved?: boolean } = {},
): Promise<Comment[]> {
  const document = await findDocument(db, viewer, documentId);
  if (!document) throw documentNotFound();
  const rows = await documentRowsOf(db, document.id);
  return present(db, viewer, includeResolved ? rows : withoutResolvedThreads(rows), document.body);
}

/** The open threads of a Document, as a Ticket's read shows them with its Reports and Linked Documents. */
export const DocumentThreads = Type.Array(Comment, {
  description:
    "The Document's unresolved threads, oldest first: each first Comment with its `quote` and `anchor` (`outdated` once " +
    "its passage is gone from the current Version), and the replies in it. A resolved thread is left out, replies and all.",
});

/**
 * The unresolved threads of each of the Documents the Viewer can read, by Document id, in one query; a Document it
 * can't read gets none, as one without threads does.
 */
export async function threadsOn(db: Db | Tx, viewer: Viewer, documentIds: string[]): Promise<Map<string, Comment[]>> {
  const threads = new Map<string, Comment[]>(documentIds.map((id) => [id, []]));
  if (documentIds.length === 0) return threads;
  const reach = inReach(viewer, { project: "documents.project_id", workspace: "documents.workspace_id" }, "$2");
  const { rows } = await db.query<Row & { currentBody: string }>(
    `select ${columns}, document_versions.body as "currentBody" from ${fromComments}
     where comments.document_id = any($1::uuid[]) and ${reach.sql}
     order by comments.seq`,
    [documentIds, reach.value],
  );
  const byDocument = new Map<string, (Row & { currentBody: string })[]>();
  for (const row of rows) byDocument.set(row.documentId!, [...(byDocument.get(row.documentId!) ?? []), row]);
  for (const [documentId, onDocument] of byDocument) {
    const open = withoutResolvedThreads(onDocument.map(({ currentBody: _, ...row }) => row));
    threads.set(documentId, await present(db, viewer, open, onDocument[0]!.currentBody));
  }
  return threads;
}

/** The Comments whose thread is open: each reply, however deep, goes with the first Comment of its thread. */
function withoutResolvedThreads(rows: Row[]): Row[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const rootOf = (row: Row): Row => {
    let at = row;
    for (let parent = at.replyToId && byId.get(at.replyToId); parent; parent = at.replyToId && byId.get(at.replyToId)) {
      at = parent;
    }
    return at;
  };
  return rows.filter((row) => rootOf(row).resolvedAt === null);
}

/**
 * Resolves the thread a Comment on a Document starts, or unresolves it, as a User with Write where the Document is
 * kept. Resolving a resolved thread, or unresolving an open one, changes nothing and tells nobody.
 */
export async function resolveDocumentThread(
  context: Context,
  actor: Caller,
  commentId: string,
  resolved: boolean,
): Promise<Comment> {
  return transaction(context.db, async (tx) => {
    const { rows: found } = isUuid(commentId)
      ? await tx.query<{
          documentId: string | null;
          ticketId: string | null;
          artifactId: string | null;
          replyToId: string | null;
          resolved: boolean;
        }>(
          `select document_id as "documentId", ticket_id as "ticketId", artifact_id as "artifactId",
             reply_to_id as "replyToId", resolved_at is not null as resolved
           from comments where id = $1 for update`,
          [commentId],
        )
      : { rows: [] };
    const comment = found[0];
    if (!comment) throw commentNotFound();
    if (comment.documentId === null) {
      // A Comment on a Ticket or an Artifact the caller can't read answers as not found, as an unknown one does.
      const readable = comment.ticketId
        ? await findTicketRow(tx, actor, comment.ticketId)
        : await findArtifact(tx, actor, comment.artifactId!);
      if (!readable) throw commentNotFound();
      throw new ApiError(400, "not_a_document_thread", "Only a thread on a Document is resolved.", {
        rule: "Threads are resolved on Documents, Reports included; a Ticket's or an Artifact's Comments stay as they are.",
        advice: "Resolve a thread on a Document, through its first Comment.",
      });
    }
    const document = await findDocument(tx, actor, comment.documentId);
    if (!document) throw commentNotFound();
    await requireWrite(tx, actor, document);
    if (actor.kind === "agent") {
      const verb = resolved ? "resolve" : "unresolve";
      requireHumanAct(actor, `${verb} a thread`);
      throw new ApiError(403, "agent_not_allowed", `${actor.name} is an Agent, and only a User can ${verb} a thread.`, {
        rule: "Only a User resolves or unresolves a thread on a Document, once its review is dealt with; Agents read threads.",
        advice: `Reply in the thread to say what you did; ask ${ownerName(actor)}, ${actor.name}'s Owner, to ${verb} it.`,
      });
    }
    if (comment.replyToId !== null) {
      throw new ApiError(400, "not_a_thread", "A thread is resolved through its first Comment, not a reply.", {
        rule: "Resolving a thread resolves it whole, through the Comment that starts it.",
        advice: "Resolve the Comment this reply's thread starts with.",
      });
    }
    if (comment.resolved !== resolved) {
      await tx.query("update comments set resolved_at = $2, resolved_by_user_id = $3 where id = $1", [
        commentId,
        resolved ? context.clock.now() : null,
        resolved ? actor.id : null,
      ]);
      context.live.publish(tx, document.workspaceId, {
        type: "comment.changed",
        projectId: document.projectId,
        documentId: document.id,
        commentId,
      });
    }
    const [updated] = await present(tx, actor, await documentRowsOf(tx, document.id, commentId), document.body);
    return updated!;
  });
}

function commentNotFound(): ApiError {
  return new ApiError(404, "not_found", "No such Comment.");
}

/**
 * Comments on a Document, or replies to one of its Comments, as the Actor: with Write where the Document is kept, as
 * on a Ticket. Its readers are told; nobody is notified.
 */
export async function addDocumentComment(
  context: Context,
  actor: Caller,
  documentId: string,
  input: DocumentCommentCreate,
): Promise<Comment> {
  return transaction(context.db, async (tx) => {
    const document = await findDocument(tx, actor, documentId);
    if (!document) throw documentNotFound();
    await requireWrite(tx, actor, document);
    // Held until the Comment is in, so a delete of the Document either went first, and it is unknown, or waits.
    const { rowCount: held } = await tx.query("select 1 from documents where id = $1 for key share", [document.id]);
    if (held === 0) throw documentNotFound();
    if (input.replyToId !== undefined) {
      const { rowCount } = isUuid(input.replyToId)
        ? await tx.query("select 1 from comments where id = $1 and document_id = $2", [input.replyToId, document.id])
        : { rowCount: 0 };
      if (rowCount === 0) throw unknownReplyTarget("Document");
    }
    const quote = input.quote === undefined ? null : quoteIn(document, input.quote, input.replyToId !== undefined);
    const commentId = await insertDocumentComment(context, tx, document, actor, input.body, input.replyToId ?? null, quote);
    const [comment] = await present(tx, actor, await documentRowsOf(tx, document.id, commentId), document.body);
    return comment!;
  });
}

/**
 * The quote as it is recorded, with the Version it is taken from: refused on a reply, which is on its thread's
 * passage, and unless it appears in the Document's current Version. An edit racing the Comment only makes its thread
 * outdated on the next read.
 */
function quoteIn(
  document: { body: string; version: { number: number } },
  quote: string,
  reply: boolean,
): { quote: string; version: number } {
  if (reply) {
    throw new ApiError(400, "quote_on_reply", "A reply takes no quote.", {
      rule: "A thread's first Comment anchors it to its passage; its replies are on the same passage.",
      advice: "Reply without `quote`, or comment on the passage without `replyToId` to start a thread of its own.",
    });
  }
  const normalised = normaliseLineEndings(quote);
  if (!normaliseLineEndings(document.body).includes(normalised)) {
    throw new ApiError(400, "quote_not_found", "The quote isn't in the Document's current Version.", {
      rule: "A Comment quotes a passage of its Document's current Version exactly, as its Markdown.",
      advice: "Read the Document again and quote its Markdown as it is now, or comment on the whole Document without `quote`.",
    });
  }
  return { quote: normalised, version: document.version.number };
}
