import { Type, type Static } from "typebox";
import type { Db } from "../db.js";
import type { Viewer } from "../identity/viewers.js";
import { DocumentThreads, threadsOn } from "../work/comments.js";
import { LinkedDocument, linkedDocumentsOf } from "./linked-documents.js";
import { Report, reportsOn } from "./reports.js";

/**
 * A Ticket's Reports and Linked Documents as its read shows them, each with its unresolved threads, so a review
 * written on a Ticket's spec or Report reaches the people and Runs working the Ticket.
 */

export const ReportWithThreads = Type.Object({ ...Report.properties, threads: DocumentThreads });
export type ReportWithThreads = Static<typeof ReportWithThreads>;

export const LinkedDocumentWithThreads = Type.Object({ ...LinkedDocument.properties, threads: DocumentThreads });
export type LinkedDocumentWithThreads = Static<typeof LinkedDocumentWithThreads>;

/** A Ticket's Reports, oldest first, each with its unresolved threads. */
export async function reportsWithThreads(db: Db, viewer: Viewer, ticketId: string): Promise<ReportWithThreads[]> {
  const reports = await reportsOn(db, viewer, ticketId);
  const threads = await threadsOn(db, viewer, reports.map((report) => report.id));
  return reports.map((report) => ({ ...report, threads: threads.get(report.id)! }));
}

/**
 * The Ticket's Linked Documents the Viewer can read, oldest link first, each with its unresolved threads; one it
 * can't read is left off, threads and all.
 */
export async function linkedDocumentsWithThreads(
  db: Db,
  viewer: Viewer,
  ticketId: string,
): Promise<LinkedDocumentWithThreads[]> {
  const documents = await linkedDocumentsOf(db, viewer, ticketId);
  const threads = await threadsOn(db, viewer, documents.map((document) => document.id));
  return documents.map((document) => ({ ...document, threads: threads.get(document.id)! }));
}
