import type { QueryKey } from "@tanstack/react-query";
import type { StreamEvent } from "./live.js";

/**
 * What screens load through TanStack Query, keyed here and only here, and which of it each Live event makes stale.
 * Every key starts with the record it belongs to (`["ticket", id, …]`), so an event about one Ticket leaves the
 * others' alone, and `["ticket", id]` alone would name everything of that Ticket.
 */
export const keys = {
  ticket: (ticketId: string) => ["ticket", ticketId, "fields"] as const,
  comments: (ticketId: string) => ["ticket", ticketId, "comments"] as const,
  reports: (ticketId: string) => ["ticket", ticketId, "reports"] as const,
  attachments: (ticketId: string) => ["ticket", ticketId, "attachments"] as const,
  timeline: (ticketId: string) => ["ticket", ticketId, "timeline"] as const,
  runs: (ticketId: string) => ["ticket", ticketId, "runs"] as const,
  transcripts: (ticketId: string) => ["ticket", ticketId, "transcripts"] as const,
  relations: (ticketId: string) => ["ticket", ticketId, "relations"] as const,
  documentLinks: (ticketId: string) => ["ticket", ticketId, "documentLinks"] as const,
  artifactLinks: (ticketId: string) => ["ticket", ticketId, "artifactLinks"] as const,
  pullRequests: (ticketId: string) => ["ticket", ticketId, "pullRequests"] as const,
  project: (projectId: string) => ["project", projectId, "fields"] as const,
  projectTickets: (projectId: string) => ["project", projectId, "tickets"] as const,
  /** A Document's files, such as a Report's, since a Report is a Document. */
  documentAttachments: (documentId: string) => ["document", documentId, "attachments"] as const,
  members: (workspaceId: string) => ["workspace", workspaceId, "members"] as const,
  agents: (workspaceId: string) => ["workspace", workspaceId, "agents"] as const,
  /** An Agent's Record, page by page. */
  agentRecord: (agentId: string) => ["agent", agentId, "record"] as const,
  /** Every Agent's Record: any of their doings may be what an event names. */
  agentRecords: ["agent"] as const,
  /** Everything loaded of one record, for the events that name only the record. */
  everythingOf: (kind: "project" | "document" | "term" | "decision" | "artifact" | "transcript", id: string) => [kind, id] as const,
  /** Every query: `[]` is a prefix of every key. */
  everything: [] as const,
};

/**
 * The Live invalidation table: the keys each event of the Workspace's stream makes stale, which the stream's one
 * subscriber hands to `invalidateQueries`. Each event type has its case, so one the server adds fails the type check
 * until it is listed; a reconnect, which may have missed anything, makes everything stale.
 */
export function invalidations(event: StreamEvent): QueryKey[] {
  switch (event.type) {
    case "reconnected":
      return [keys.everything];
    case "project.created":
    case "project.gained":
    case "project.lost":
      return [keys.everythingOf("project", event.projectId)];
    case "project.changed":
    case "statuses.changed":
      return [keys.project(event.projectId)];
    case "ticket.created":
      return [keys.projectTickets(event.projectId)];
    case "ticket.changed":
      // Its Runs and Relations change with it, and the Project's Tickets list its key, title and Labels.
      return [
        keys.ticket(event.ticketId),
        keys.timeline(event.ticketId),
        keys.runs(event.ticketId),
        keys.transcripts(event.ticketId),
        keys.relations(event.ticketId),
        keys.documentLinks(event.ticketId),
        keys.artifactLinks(event.ticketId),
        // Linking or unlinking an Artifact brings its Comments onto the timeline, or takes them off.
        keys.comments(event.ticketId),
        keys.projectTickets(event.projectId),
        // A Run starting or ending, or a Change made, is an Agent's doing.
        keys.agentRecords,
      ];
    case "comment.added":
      return [keys.comments(event.ticketId), keys.agentRecords];
    case "report.added":
    case "report.changed":
      return [keys.reports(event.ticketId), keys.documentAttachments(event.reportId), keys.agentRecords];
    case "attachments.changed":
      // A Comment's files come with its Comments; a Report's are its Document's.
      return "ticketId" in event
        ? [keys.attachments(event.ticketId), keys.comments(event.ticketId), keys.reports(event.ticketId)]
        : [keys.documentAttachments(event.documentId)];
    case "pull_requests.changed":
      return [keys.pullRequests(event.ticketId)];
    case "transcripts.changed":
      return [keys.transcripts(event.ticketId), keys.agentRecords];
    // Saving any of these makes a Version, which may be an Agent's.
    case "document.changed":
      return [keys.everythingOf("document", event.documentId), keys.agentRecords];
    case "term.changed":
      return [keys.everythingOf("term", event.termId), keys.agentRecords];
    case "decision.changed":
      return [keys.everythingOf("decision", event.decisionId), keys.agentRecords];
    case "artifact.changed":
    case "artifact.comments.changed":
      return [keys.everythingOf("artifact", event.artifactId), keys.agentRecords];
    case "transcript.changed":
      return [keys.everythingOf("transcript", event.transcriptId), keys.agentRecords];
    default:
      return unlisted(event);
  }
}

function unlisted(event: never): never {
  throw new Error(`No Live invalidation for ${(event as { type: string }).type}.`);
}
