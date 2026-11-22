import type { Context } from "../context.js";
import type { Tx } from "../db.js";
import type { PlacedEvent } from "../live/live.js";

/**
 * Tells the Workspace that an Artifact's Comments changed, a Comment added or a file attached to one: the Artifact's
 * readers, and the readers of each Ticket linking it with the Ticket's own event, since its Comments show there.
 */
export async function publishArtifactComments(
  { live }: Context,
  tx: Tx,
  artifact: { id: string; workspaceId: string; projectId: string | null },
  ticketEvent: (ticket: { projectId: string; ticketId: string }) => PlacedEvent,
): Promise<void> {
  live.publish(tx, artifact.workspaceId, { type: "artifact.comments.changed", projectId: artifact.projectId, artifactId: artifact.id });
  const { rows } = await tx.query<{ ticketId: string; projectId: string }>(
    `select tickets.id as "ticketId", tickets.project_id as "projectId"
     from linked_artifacts join tickets on tickets.id = linked_artifacts.ticket_id
     where linked_artifacts.artifact_id = $1 order by linked_artifacts.seq`,
    [artifact.id],
  );
  for (const ticket of rows) live.publish(tx, artifact.workspaceId, ticketEvent(ticket));
}
