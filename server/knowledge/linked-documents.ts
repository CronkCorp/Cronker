import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { transaction, type Db, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import type { Caller } from "../identity/callers.js";
import { slugColumn, slugDescription } from "../http/readable.js";
import { inReach, requireWrite, type Viewer } from "../identity/viewers.js";
import { recordChanges, type ChangeActor } from "../work/changes.js";
import { findTicketRow, linkingActor, ticketNotFound, type TicketRow } from "../work/tickets.js";
import { findDocument } from "./documents.js";

/**
 * Linked Documents: Documents of a Ticket's Project or of the Workspace, linked from the Ticket's side so they are
 * one click away. A deleted Document drops out of its links.
 */

export const LinkedDocument = Type.Object({
  id: Type.String({ format: "uuid", description: "The Document's id." }),
  projectId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
    description: "The Project whose page tree holds it, or null for the Workspace's.",
  }),
  title: Type.String({ description: "Its current Version's title." }),
  slug: Type.String({ description: slugDescription }),
});
export type LinkedDocument = Static<typeof LinkedDocument>;

const columns = `documents.id, documents.project_id as "projectId", versions.title,
  ${slugColumn("document", "documents.id", "versions.title")} as slug`;
const fromLinks = `linked_documents
  join documents on documents.id = linked_documents.document_id
  join document_versions versions on versions.document_id = documents.id and versions.number = documents.version`;

/** The Ticket's Linked Documents the Viewer can read, oldest link first. */
export async function linkedDocumentsOf(db: Db, viewer: Viewer, ticketId: string): Promise<LinkedDocument[]> {
  const ticket = await findTicketRow(db, viewer, ticketId);
  if (!ticket) throw ticketNotFound();
  // Only those the Viewer can read: one it can't is left off, as if it weren't linked.
  const reach = inReach(viewer, { project: "documents.project_id", workspace: "documents.workspace_id" }, "$2");
  const { rows } = await db.query<LinkedDocument>(
    `select ${columns} from ${fromLinks} where linked_documents.ticket_id = $1 and ${reach.sql} order by linked_documents.seq`,
    [ticket.id, reach.value],
  );
  return rows;
}

/** A Document as a link's Change names it: its id, and its title then. */
type Named = { id: string; title: string };

/**
 * Links a Document of the Ticket's Project or of its Workspace to the Ticket. A User links on any Ticket; an Agent
 * only during its own running Run on it, or on a Discovered Ticket it filed that waits for a User.
 */
export async function linkDocument(
  context: Context,
  caller: Caller,
  ticketId: string,
  documentId: string,
): Promise<LinkedDocument> {
  return transaction(context.db, async (tx) => {
    const ticket = await findTicketRow(tx, caller, ticketId, { lock: true });
    if (!ticket) throw ticketNotFound();
    await requireWrite(tx, caller, ticket);
    const actor = await linkingActor(tx, caller, ticket, "Document");
    // Held until the link is made, so a delete of the Document either went first, and it is unknown, or waits.
    if (isUuid(documentId)) await tx.query("select 1 from documents where id = $1 for key share", [documentId]);
    // A Document of another Workspace answers as unknown, even to a User who belongs to both.
    const document = await findDocument(tx, caller, documentId);
    if (!document || document.workspaceId !== ticket.workspaceId) {
      throw new ApiError(400, "unknown_document", "That Document isn't in this Workspace.");
    }
    if (document.projectId !== null && document.projectId !== ticket.projectId) {
      throw new ApiError(400, "document_outside_project", `${document.title} is in another Project's page tree.`, {
        rule: "A Ticket links Documents of its own Project or of the Workspace, not of another Project.",
        advice: `Link a Document of ${ticket.key}'s Project or of the Workspace, or mention the Document in a Comment.`,
      });
    }
    const { rowCount } = await tx.query(
      `insert into linked_documents (ticket_id, document_id, workspace_id, created_at) values ($1, $2, $3, $4)
       on conflict do nothing`,
      [ticket.id, document.id, ticket.workspaceId, context.clock.now()],
    );
    if (!rowCount) throw new ApiError(409, "document_already_linked", `${ticket.key} already links ${document.title}.`);
    const linked: LinkedDocument = { id: document.id, projectId: document.projectId, title: document.title, slug: document.slug };
    await recordLinkChange(context, tx, ticket, actor, { from: null, to: { id: linked.id, title: linked.title } });
    return linked;
  });
}

/**
 * Unlinks a Document from the Ticket, by a User or by an Agent that may link on it; the Document stays in its page
 * tree.
 */
export async function unlinkDocument(context: Context, caller: Caller, ticketId: string, documentId: string): Promise<void> {
  await transaction(context.db, async (tx) => {
    const ticket = await findTicketRow(tx, caller, ticketId, { lock: true });
    if (!ticket) throw ticketNotFound();
    await requireWrite(tx, caller, ticket);
    const actor = await linkingActor(tx, caller, ticket, "Document");
    const { rows } = isUuid(documentId)
      ? await tx.query<LinkedDocument>(
          `select ${columns} from ${fromLinks}
           where linked_documents.ticket_id = $1 and linked_documents.document_id = $2 for update of linked_documents`,
          [ticket.id, documentId],
        )
      : { rows: [] };
    const unlinked = rows[0];
    if (!unlinked) throw new ApiError(404, "not_found", `${ticket.key} links no such Document.`);
    await tx.query("delete from linked_documents where ticket_id = $1 and document_id = $2", [ticket.id, unlinked.id]);
    await recordLinkChange(context, tx, ticket, actor, { from: { id: unlinked.id, title: unlinked.title }, to: null });
  });
}


/**
 * Records a Document linked (`to`) or unlinked (`from`) on the Ticket's timeline, named as it is titled now, and
 * tells the Workspace's live streams the Ticket changed.
 */
async function recordLinkChange(
  { clock, live }: Context,
  tx: Tx,
  ticket: TicketRow,
  actor: ChangeActor,
  change: { from: Named; to: null } | { from: null; to: Named },
): Promise<void> {
  await recordChanges(tx, ticket, actor, clock.now(), [{ field: "linkedDocument", ...change }]);
  live.publish(tx, ticket.workspaceId, { type: "ticket.changed", projectId: ticket.projectId, ticketId: ticket.id });
}
