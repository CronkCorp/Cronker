import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { transaction, type Db, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import type { Caller } from "../identity/callers.js";
import type { Viewer } from "../identity/viewers.js";
import { recordChanges, type ChangeActor } from "../work/changes.js";
import { findTicketRow, runOfAgent, ticketNotFound, type TicketRow } from "../work/tickets.js";
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
});
export type LinkedDocument = Static<typeof LinkedDocument>;

const columns = `documents.id, documents.project_id as "projectId", versions.title`;
const fromLinks = `linked_documents
  join documents on documents.id = linked_documents.document_id
  join document_versions versions on versions.document_id = documents.id and versions.number = documents.version`;

/** The Ticket's Linked Documents, oldest link first. */
export async function linkedDocumentsOf(db: Db, viewer: Viewer, ticketId: string): Promise<LinkedDocument[]> {
  const ticket = await findTicketRow(db, viewer, ticketId);
  if (!ticket) throw ticketNotFound();
  const { rows } = await db.query<LinkedDocument>(
    `select ${columns} from ${fromLinks} where linked_documents.ticket_id = $1 order by linked_documents.seq`,
    [ticket.id],
  );
  return rows;
}

/**
 * Links a Document of the Ticket's Project or of its Workspace to the Ticket. A User links on any Ticket; an Agent
 * only during its own running Run on it.
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
    const actor = await linkingActor(tx, caller, ticket);
    // A Document of another Workspace answers as unknown, even to a User who belongs to both.
    const document = await findDocument(tx, caller, documentId);
    if (!document || document.workspaceId !== ticket.workspaceId) throw new ApiError(400, "unknown_document", "That Document isn't in this Workspace.");
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
    await recordLinkChange(context, tx, ticket, actor, { id: document.id, title: document.title }, "linked");
    return { id: document.id, projectId: document.projectId, title: document.title };
  });
}

/** Unlinks a Document from the Ticket, by a User or by an Agent during its Run on it; the Document stays in its page tree. */
export async function unlinkDocument(context: Context, caller: Caller, ticketId: string, documentId: string): Promise<void> {
  await transaction(context.db, async (tx) => {
    const ticket = await findTicketRow(tx, caller, ticketId, { lock: true });
    if (!ticket) throw ticketNotFound();
    const actor = await linkingActor(tx, caller, ticket);
    const { rows } = isUuid(documentId)
      ? await tx.query<{ id: string; title: string }>(
          `delete from linked_documents using documents, document_versions versions
           where linked_documents.ticket_id = $1 and linked_documents.document_id = $2
             and documents.id = linked_documents.document_id
             and versions.document_id = documents.id and versions.number = documents.version
           returning documents.id, versions.title`,
          [ticket.id, documentId],
        )
      : { rows: [] };
    const unlinked = rows[0];
    if (!unlinked) throw new ApiError(404, "not_found", `${ticket.key} links no such Document.`);
    await recordLinkChange(context, tx, ticket, actor, unlinked, "unlinked");
  });
}

/** Who links or unlinks: a User, or an Agent only during its own running Run on the Ticket, refused otherwise. */
async function linkingActor(tx: Tx, caller: Caller, ticket: TicketRow): Promise<ChangeActor> {
  if (caller.kind === "user") return caller.id;
  return { kind: "agent", id: caller.id, runId: await runOfAgent(tx, caller, ticket) };
}

/**
 * Records a Document linked or unlinked on the Ticket's timeline, naming it as it is titled now, and tells the
 * Workspace's live streams the Ticket changed.
 */
async function recordLinkChange(
  { clock, live }: Context,
  tx: Tx,
  ticket: TicketRow,
  actor: ChangeActor,
  document: { id: string; title: string },
  linkedOrUnlinked: "linked" | "unlinked",
): Promise<void> {
  const [from, to] = linkedOrUnlinked === "linked" ? [null, document] : [document, null];
  await recordChanges(tx, ticket, actor, clock.now(), [{ field: "linkedDocument", from, to }]);
  live.publish(tx, ticket.workspaceId, { type: "ticket.changed", projectId: ticket.projectId, ticketId: ticket.id });
}

/** Tells the Workspace's live streams that each Ticket linking the Document changed, before it is deleted. */
export async function publishLinkingTickets({ live }: Context, tx: Tx, document: { id: string; workspaceId: string }): Promise<void> {
  const { rows } = await tx.query<{ ticketId: string; projectId: string }>(
    `select tickets.id as "ticketId", tickets.project_id as "projectId"
     from linked_documents join tickets on tickets.id = linked_documents.ticket_id
     where linked_documents.document_id = $1 order by linked_documents.seq`,
    [document.id],
  );
  for (const { ticketId, projectId } of rows) {
    live.publish(tx, document.workspaceId, { type: "ticket.changed", projectId, ticketId });
  }
}
