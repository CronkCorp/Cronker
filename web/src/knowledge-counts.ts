import type { Inbox } from "./api.js";

/** The kinds of knowledge the sidebar links to, each with its own count of New knowledge. */
export type KnowledgeKind = "document" | "term" | "decision" | "artifact";

export type KnowledgeCounts = Record<KnowledgeKind, number>;

/**
 * The New knowledge waiting in the Inbox for one place, by kind: a Project's, given its id, or the Workspace's
 * own, given null. The Inbox already holds only what counts (Agent-created, undismissed, proposed Decisions), so
 * this only sorts its items.
 */
export function knowledgeCounts(inbox: Pick<Inbox, "items"> | null, projectId: string | null): KnowledgeCounts {
  const counts: KnowledgeCounts = { document: 0, term: 0, decision: 0, artifact: 0 };
  for (const item of inbox?.items ?? [])
    if (item.kind === "knowledge" && item.subject.projectId === projectId) counts[item.subject.kind] += 1;
  return counts;
}
