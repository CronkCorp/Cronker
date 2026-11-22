import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { Type, type Static } from "typebox";
import { megabyte } from "../config.js";
import type { Context } from "../context.js";
import { afterCommit, transaction, type Db, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import { ownerName } from "../agents/tokens.js";
import type { Caller } from "../identity/callers.js";
import { inReach, requireWrite, type Viewer } from "../identity/viewers.js";
import { Actor, actorColumn } from "../work/actors.js";
import { findTicketRow, holdsDiscoveredTicket, runOfAgent, ticketNotFound } from "../work/tickets.js";
import { publishArtifactComments } from "../work/artifact-comment-events.js";

/**
 * Attachments: plain files attached to a Ticket, a Document or a Comment, readable by whoever can read what they're
 * attached to. Their bytes are kept by the Attachment storage; what describes them is kept here.
 */

/** What an Attachment is attached to. */
export const Owner = Type.Object({
  kind: Type.Union([Type.Literal("ticket"), Type.Literal("document"), Type.Literal("comment")]),
  id: Type.String({ format: "uuid" }),
});
export type Owner = Static<typeof Owner>;
export type OwnerKind = Owner["kind"];

export const Attachment = Type.Object({
  id: Type.String({ format: "uuid", description: "Markdown refers to the Attachment as `attachment:<id>`." }),
  name: Type.String({ description: "The file's name, as it was attached." }),
  mediaType: Type.String({ description: "The media type it was attached with, such as `image/png`." }),
  size: Type.Integer({ minimum: 0, description: "In bytes." }),
  on: Type.Object(Owner.properties, { description: "The Ticket, Document or Comment it is attached to." }),
  actor: Actor,
  createdAt: Type.String({ format: "date-time" }),
});
export type Attachment = Static<typeof Attachment>;

type Row = Omit<Attachment, "createdAt" | "size"> & { createdAt: Date; size: string; workspaceId: string };

const columns = `attachments.id, attachments.name, attachments.media_type as "mediaType", attachments.size,
  case when attachments.ticket_id is not null then json_build_object('kind', 'ticket', 'id', attachments.ticket_id)
    when attachments.document_id is not null then json_build_object('kind', 'document', 'id', attachments.document_id)
    else json_build_object('kind', 'comment', 'id', attachments.comment_id) end as on,
  ${actorColumn("users", "agents")} as actor, attachments.created_at as "createdAt",
  attachments.workspace_id as "workspaceId"`;

const fromAttachments = `attachments
  left join users on users.id = attachments.actor_user_id
  left join agents on agents.id = attachments.actor_agent_id`;

const present = ({ workspaceId: _, ...row }: Row): Attachment => ({
  ...row,
  size: Number(row.size),
  createdAt: row.createdAt.toISOString(),
});

const ownerColumn = { ticket: "ticket_id", document: "document_id", comment: "comment_id" } as const;

export function attachmentNotFound(): ApiError {
  return new ApiError(404, "not_found", "No such Attachment.");
}

/** What an Attachment's owner is, found in the Viewer's view: its Workspace, and the Ticket it is on or with. */
interface FoundOwner extends Owner {
  workspaceId: string;
  /** The Ticket, and its Project, a Ticket or Comment Attachment shows with; none for a Document or an Artifact's Comment. */
  ticket: { id: string; projectId: string } | null;
  /** The Artifact a Comment is on; none otherwise. */
  artifactId?: string | null;
  /** The Project it is in: its Ticket's, its Artifact's or its Document's; null for the Workspace's own. */
  projectId: string | null;
  /** A Comment's author. */
  author?: { kind: "user" | "agent"; id: string };
}

const ownerNames = { ticket: "Ticket", document: "Document", comment: "Comment" } as const;

/** The Ticket, Document or Comment in the Viewer's view; refused as not found otherwise. */
async function findOwner(db: Db | Tx, viewer: Viewer, owner: Owner): Promise<FoundOwner> {
  const notFound = new ApiError(404, "not_found", `No such ${ownerNames[owner.kind]}.`);
  if (!isUuid(owner.id)) throw notFound;
  if (owner.kind === "ticket") {
    const ticket = await findTicketRow(db, viewer, owner.id);
    if (!ticket) throw ticketNotFound();
    return {
      ...owner,
      workspaceId: ticket.workspaceId,
      ticket: { id: ticket.id, projectId: ticket.projectId },
      projectId: ticket.projectId,
    };
  }
  if (owner.kind === "document") {
    const view = inReach(viewer, { project: "documents.project_id", workspace: "documents.workspace_id" }, "$2");
    const { rows } = await db.query<{ workspaceId: string; projectId: string | null }>(
      `select documents.workspace_id as "workspaceId", documents.project_id as "projectId"
       from documents where documents.id = $1 and ${view.sql}`,
      [owner.id, view.value],
    );
    if (!rows[0]) throw notFound;
    return { ...owner, workspaceId: rows[0].workspaceId, ticket: null, projectId: rows[0].projectId };
  }
  const view = inReach(
    viewer,
    { project: "coalesce(tickets.project_id, artifacts.project_id)", workspace: "comments.workspace_id" },
    "$2",
  );
  const { rows } = await db.query<{
    workspaceId: string;
    ticketId: string | null;
    artifactId: string | null;
    projectId: string | null;
    author: FoundOwner["author"];
  }>(
    `select comments.workspace_id as "workspaceId", comments.ticket_id as "ticketId", comments.artifact_id as "artifactId",
       coalesce(tickets.project_id, artifacts.project_id) as "projectId",
       case when comments.actor_agent_id is null then json_build_object('kind', 'user', 'id', comments.actor_user_id)
         else json_build_object('kind', 'agent', 'id', comments.actor_agent_id) end as author
     from comments left join tickets on tickets.id = comments.ticket_id
     left join artifacts on artifacts.id = comments.artifact_id
     where comments.id = $1 and ${view.sql}`,
    [owner.id, view.value],
  );
  const comment = rows[0];
  if (!comment) throw notFound;
  return {
    ...owner,
    workspaceId: comment.workspaceId,
    ticket: comment.ticketId ? { id: comment.ticketId, projectId: comment.projectId! } : null,
    artifactId: comment.artifactId,
    projectId: comment.projectId,
    author: comment.author,
  };
}

/**
 * Refuses a caller who may not attach to the owner. Users may to any Ticket and Document, and to their own
 * Comments. Agents may to a Document, to their own Comments, and to a Ticket during their running Run on it or while
 * it is a Discovered Ticket they filed that waits for a User.
 */
async function checkMayAttach(tx: Tx, caller: Caller, owner: FoundOwner): Promise<void> {
  if (owner.kind === "comment" && (owner.author!.kind !== caller.kind || owner.author!.id !== caller.id)) {
    throw new ApiError(403, "not_comment_author", "Only a Comment's author attaches files to it.", {
      rule: "An Actor attaches files only to the Comments they wrote.",
      advice: "Write a Comment of your own and attach the file to it, or attach it to the Ticket during your Run on it.",
    });
  }
  if (owner.kind === "ticket" && caller.kind === "agent") {
    const ticket = (await findTicketRow(tx, caller, owner.id))!;
    if (!holdsDiscoveredTicket(caller, ticket)) await runOfAgent(tx, caller, ticket);
  }
}

/** Refuses a body over the configured limit, naming it. */
export function attachmentTooLarge(limitBytes: number): ApiError {
  const limit = describeSize(limitBytes);
  return new ApiError(413, "attachment_too_large", `An Attachment may be at most ${limit}.`, {
    rule: `Each Attachment is at most ${limit}, as Cronk is configured.`,
    advice: "Attach a smaller file: compress it, crop it, or keep only the part that matters.",
  });
}

/** A size as people read it: in MB or KB when it is a whole number of them, otherwise in bytes. */
export function describeSize(bytes: number): string {
  if (bytes % megabyte === 0) return `${bytes / megabyte} MB`;
  if (bytes % 1024 === 0) return `${bytes / 1024} KB`;
  return `${bytes} bytes`;
}

/** A media type as given in a `Content-Type` header, without its parameters, or `application/octet-stream`. */
export function mediaTypeOf(contentType: string | undefined): string {
  const type = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(type) ? type : "application/octet-stream";
}

/**
 * Attaches a file to the Ticket, Document or Comment, as the Actor, within the configured limit. Its bytes are
 * kept before its record commits, and forgotten again if it doesn't.
 */
export async function addAttachment(
  context: Context,
  actor: Caller,
  owner: Owner,
  file: { name: string; mediaType: string; bytes: Buffer },
): Promise<Attachment> {
  const { db, clock, attachments, config } = context;
  if (file.bytes.length > config.attachments.limitBytes) throw attachmentTooLarge(config.attachments.limitBytes);
  const id = randomUUID();
  try {
    return await transaction(db, async (tx) => {
      const found = await findOwner(tx, actor, owner);
      await requireWrite(tx, actor, found);
      await checkMayAttach(tx, actor, found);
      await attachments.put(id, file.bytes);
      await tx.query(
        `insert into attachments (id, workspace_id, ${ownerColumn[owner.kind]}, name, media_type, size, actor_user_id,
           actor_agent_id, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          id,
          found.workspaceId,
          owner.id,
          file.name,
          file.mediaType,
          file.bytes.length,
          actor.kind === "user" ? actor.id : null,
          actor.kind === "agent" ? actor.id : null,
          clock.now(),
        ],
      );
      await publishChange(context, tx, found);
      return (await findAttachment(tx, actor, id))!;
    });
  } catch (error) {
    // Nothing refers to bytes kept for a record that never committed.
    await forgetAttachments(context, [id]);
    throw error;
  }
}

async function publishChange(context: Context, tx: Tx, owner: FoundOwner): Promise<void> {
  const { live } = context;
  if (owner.artifactId) {
    const artifact = { id: owner.artifactId, workspaceId: owner.workspaceId, projectId: owner.projectId };
    await publishArtifactComments(context, tx, artifact, (ticket) => ({ type: "attachments.changed", ...ticket }));
  } else if (owner.ticket) {
    live.publish(tx, owner.workspaceId, { type: "attachments.changed", projectId: owner.ticket.projectId, ticketId: owner.ticket.id });
  } else {
    live.publish(tx, owner.workspaceId, { type: "attachments.changed", documentId: owner.id }, { readersOf: [owner.projectId] });
  }
}

/**
 * The Project an Attachment is in, as SQL: its Ticket's, its Comment's Ticket's or Artifact's, or its Document's; none
 * for the Workspace's own.
 */
const attachmentProject = `coalesce(
  (select attachment_tickets.project_id from tickets attachment_tickets
   where attachment_tickets.id = coalesce(attachments.ticket_id,
     (select attachment_comments.ticket_id from comments attachment_comments where attachment_comments.id = attachments.comment_id))),
  (select attachment_artifacts.project_id from comments attachment_comments
   join artifacts attachment_artifacts on attachment_artifacts.id = attachment_comments.artifact_id
   where attachment_comments.id = attachments.comment_id),
  (select attachment_documents.project_id from documents attachment_documents where attachment_documents.id = attachments.document_id))`;

/** An Attachment in the Viewer's view; otherwise nothing, as if it didn't exist. */
export async function findAttachment(db: Db | Tx, viewer: Viewer, attachmentId: string): Promise<Attachment | undefined> {
  const row = await findRow(db, viewer, attachmentId);
  return row && present(row);
}

async function findRow(db: Db | Tx, viewer: Viewer, attachmentId: string, { lock = false } = {}): Promise<Row | undefined> {
  if (!isUuid(attachmentId)) return undefined;
  const view = inReach(viewer, { project: attachmentProject, workspace: "attachments.workspace_id" }, "$2");
  const { rows } = await db.query<Row>(
    `select ${columns} from ${fromAttachments} where attachments.id = $1 and ${view.sql}
     ${lock ? "for update of attachments" : ""}`,
    [attachmentId, view.value],
  );
  return rows[0];
}

/** What is attached to the Ticket, Document or Comment, oldest first. */
export async function attachmentsOn(db: Db, viewer: Viewer, owner: Owner): Promise<Attachment[]> {
  await findOwner(db, viewer, owner);
  const { rows } = await db.query<Row>(
    `select ${columns} from ${fromAttachments} where attachments.${ownerColumn[owner.kind]} = $1
     order by attachments.created_at, attachments.id`,
    [owner.id],
  );
  return rows.map(present);
}

/** What is attached to each of the Comments, oldest first, by Comment id. */
export async function attachmentsOnComments(db: Db | Tx, commentIds: string[]): Promise<Map<string, Attachment[]>> {
  const byComment = new Map<string, Attachment[]>(commentIds.map((id) => [id, []]));
  if (commentIds.length === 0) return byComment;
  const { rows } = await db.query<Row>(
    `select ${columns} from ${fromAttachments} where attachments.comment_id = any($1::uuid[])
     order by attachments.created_at, attachments.id`,
    [commentIds],
  );
  for (const row of rows) byComment.get(row.on.id)?.push(present(row));
  return byComment;
}

/** An Attachment's bytes, for a Viewer who can read what it's attached to. */
export async function attachmentContent(
  { db, attachments }: Context,
  viewer: Viewer,
  attachmentId: string,
): Promise<{ attachment: Attachment; content: Readable }> {
  const attachment = await findAttachment(db, viewer, attachmentId);
  if (!attachment) throw attachmentNotFound();
  const content = await attachments.get(attachment.id);
  if (!content) throw new ApiError(404, "attachment_file_missing", `${attachment.name}'s file is missing from Cronk's storage.`);
  return { attachment, content };
}

/**
 * Removes an Attachment. Users remove any, so whatever an Agent attached can be taken down; an Agent removes only
 * what it attached itself, to what it may still attach to. Its bytes are forgotten once the removal commits.
 */
export async function removeAttachment(context: Context, actor: Caller, attachmentId: string): Promise<void> {
  await transaction(context.db, async (tx) => {
    const row = await findRow(tx, actor, attachmentId, { lock: true });
    if (!row) throw attachmentNotFound();
    const found = await findOwner(tx, actor, row.on);
    await requireWrite(tx, actor, found);
    if (actor.kind === "agent") {
      if (row.actor.kind !== "agent" || row.actor.id !== actor.id) {
        throw new ApiError(403, "agent_not_allowed", `${actor.name} is an Agent, and removes only Attachments it added.`, {
          rule: "An Agent removes only the Attachments it added itself, so it can't remove what others attached.",
          advice: `Leave the Attachment as it is; ask ${ownerName(actor)}, ${actor.name}'s Owner, if it should go.`,
        });
      }
      await checkMayAttach(tx, actor, found);
    }
    await tx.query("delete from attachments where id = $1", [row.id]);
    await publishChange(context, tx, found);
    afterCommit(tx, () => forgetAttachments(context, [row.id]));
  });
}

/**
 * Forgets the bytes of Attachments whose records are gone. The removal has committed whatever happens here, so a
 * file that can't be deleted is left behind rather than failing it.
 */
export async function forgetAttachments({ attachments }: Context, ids: string[]): Promise<void> {
  await Promise.all(ids.map((id) => attachments.delete(id).catch(() => {})));
}
