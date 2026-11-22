import { Type, type Static } from "typebox";
import { Attachment, attachmentsOnComments } from "../attachments/attachments.js";
import type { Context } from "../context.js";
import { transaction, type Db, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import type { Caller } from "../identity/callers.js";
import { inReach, requireWrite, type Viewer } from "../identity/viewers.js";
import { answerQuestion } from "../runs/questions.js";
import { insertComment } from "./comment-writes.js";
import { ActorOrCronk, actorOrCronkColumn } from "./actors.js";
import { findTicketRow, ticketNotFound } from "./tickets.js";
import { Mention, mentionsOf } from "./mentions.js";
import { slugColumn } from "../http/readable.js";
import { artifactNotFound, findArtifact } from "../artifacts/artifacts.js";
import { insertArtifactComment } from "./comment-writes.js";

/** The Artifact a Comment is on, as a Ticket's timeline marks it. */
export const CommentArtifact = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    projectId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
    title: Type.String({ description: "Its current title." }),
    slug: Type.String(),
  },
  { description: "The Artifact the Comment is on; null for a Comment on a Ticket." },
);
import { markdown } from "./fields.js";

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

export const Comment = Type.Object({
  id: Type.String({ format: "uuid" }),
  ticketId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
    description: "The Ticket it is on; null for a Comment on an Artifact.",
  }),
  artifactId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
    description:
      "The Artifact it is on; null for a Comment on a Ticket. A Ticket's Comments include those on its Linked " +
      "Artifacts, each naming its Artifact here and in `artifact`; replies to one go to the Artifact.",
  }),
  artifact: Type.Union([CommentArtifact, Type.Null()]),
  replyToId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
  body: Type.String({ description: "Markdown." }),
  actor: Type.Union([...ActorOrCronk.anyOf, GitHubAuthor], {
    description: "Who wrote it: a User, an Agent, Cronk itself, or for a Comment imported from GitHub, its author's GitHub account when no User has linked it.",
  }),
  createdAt: Type.String({ format: "date-time" }),
  mentions: Type.Array(Mention, { description: "The Ticket and Decision keys its body mentions and the Artifacts it embeds that the caller may read." }),
  attachments: Type.Array(Attachment, { description: "The files attached to the Comment, oldest first." }),
  questionId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
    description: "The Question this Comment asks, if a Run asked one with it; the first User's reply answers it.",
  }),
  sentBack: Type.Boolean({
    description: "Whether this is Cronk's Comment on a send-back, linking the failing check or the review requesting changes.",
  }),
});
export type Comment = Static<typeof Comment>;

type Row = Omit<Comment, "createdAt" | "mentions" | "attachments"> & { createdAt: Date };

const columns = `comments.id, comments.ticket_id as "ticketId", comments.artifact_id as "artifactId",
  case when artifacts.id is null then null else json_build_object('id', artifacts.id, 'projectId', artifacts.project_id,
    'title', artifact_versions.title, 'slug', ${slugColumn("artifact", "artifacts.id", "artifact_versions.title")}) end as artifact,
  comments.reply_to_id as "replyToId", comments.body,
  case when comments.github_author_login is not null then json_build_object('kind', 'github',
    'login', comments.github_author_login, 'name', '@' || comments.github_author_login || ' on GitHub')
    else ${actorOrCronkColumn("users", "agents")} end as actor, comments.created_at as "createdAt", questions.id as "questionId",
  comments.sent_back as "sentBack"`;

const fromComments = `comments
  left join users on users.id = comments.actor_user_id
  left join agents on agents.id = comments.actor_agent_id
  left join questions on questions.comment_id = comments.id
  left join artifacts on artifacts.id = comments.artifact_id
  left join artifact_versions on artifact_versions.artifact_id = artifacts.id and artifact_versions.number = artifacts.version`;

/**
 * The Ticket's Comments, oldest first, with those on its Linked Artifacts the Viewer can read among them; or only
 * the one given.
 */
async function rowsOf(db: Db | Tx, viewer: Viewer, ticketId: string, commentId?: string): Promise<Row[]> {
  const reach = inReach(viewer, { project: "artifacts.project_id", workspace: "artifacts.workspace_id" }, "$2");
  const { rows } = await db.query<Row>(
    `select ${columns} from ${fromComments}
     where (comments.ticket_id = $1 or (comments.artifact_id in
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

/** Comments as the API shows them, finding the Ticket keys of all their bodies, and their Attachments, at once. */
async function present(db: Db | Tx, viewer: Viewer, rows: Row[]): Promise<Comment[]> {
  const mentions = await mentionsOf(db, viewer, "comment", rows.map((row) => row.id));
  const attachments = await attachmentsOnComments(db, rows.map((row) => row.id));
  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    mentions: mentions.get(row.id)!,
    attachments: attachments.get(row.id)!,
  }));
}

export async function commentsOn(db: Db, viewer: Viewer, ticketId: string): Promise<Comment[]> {
  const ticket = await findTicketRow(db, viewer, ticketId);
  if (!ticket) throw ticketNotFound();
  return present(db, viewer, await rowsOf(db, viewer, ticket.id));
}

/** The comment route's body: a Comment, or a reply to one. */
export const CommentCreate = Type.Object({
  body: markdown(100_000),
  replyToId: Type.Optional(Type.String({ description: "The id of the Comment on this Ticket or Artifact being replied to." })),
});
export type CommentCreate = Static<typeof CommentCreate>;

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

function unknownReplyTarget(on: "Ticket" | "Artifact"): ApiError {
  return new ApiError(400, "unknown_comment", `Replies go to a Comment on the same ${on}.`, {
    rule: `A reply answers a Comment on the ${on} it is written on.`,
    advice:
      on === "Ticket"
        ? "Reply to a Comment on an Artifact through the Artifact, as its Comment names it, or comment without `replyToId`."
        : "Name a Comment of this Artifact as `replyToId`, or comment without it.",
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
  input: { body: string; replyToId?: string },
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
