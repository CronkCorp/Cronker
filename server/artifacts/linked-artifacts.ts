import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { transaction, type Db, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import type { Caller } from "../identity/callers.js";
import type { Viewer } from "../identity/viewers.js";
import { recordChanges, type ChangeActor } from "../work/changes.js";
import { findTicketRow, runOfAgent, ticketNotFound, type TicketRow } from "../work/tickets.js";
import { findArtifact } from "./artifacts.js";

/**
 * Linked Artifacts: Artifacts of a Ticket's Project or of the Workspace, linked from the Ticket's side as Linked
 * Documents are, so they are one click away. A deleted Artifact drops out of its links.
 */

export const LinkedArtifact = Type.Object({
  id: Type.String({ format: "uuid", description: "The Artifact's id." }),
  projectId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
    description: "The Project it is kept in, or null for the Workspace.",
  }),
  title: Type.String({ description: "Its current Version's title." }),
});
export type LinkedArtifact = Static<typeof LinkedArtifact>;

const columns = `artifacts.id, artifacts.project_id as "projectId", versions.title`;
const fromLinks = `linked_artifacts
  join artifacts on artifacts.id = linked_artifacts.artifact_id
  join artifact_versions versions on versions.artifact_id = artifacts.id and versions.number = artifacts.version`;

/** The Ticket's Linked Artifacts, oldest link first. */
export async function linkedArtifactsOf(db: Db, viewer: Viewer, ticketId: string): Promise<LinkedArtifact[]> {
  const ticket = await findTicketRow(db, viewer, ticketId);
  if (!ticket) throw ticketNotFound();
  const { rows } = await db.query<LinkedArtifact>(
    `select ${columns} from ${fromLinks} where linked_artifacts.ticket_id = $1 order by linked_artifacts.seq`,
    [ticket.id],
  );
  return rows;
}

/**
 * Links an Artifact of the Ticket's Project or of its Workspace to the Ticket. A User links on any Ticket; an Agent
 * only during its own running Run on it.
 */
export async function linkArtifact(context: Context, caller: Caller, ticketId: string, artifactId: string): Promise<LinkedArtifact> {
  return transaction(context.db, async (tx) => {
    const ticket = await findTicketRow(tx, caller, ticketId, { lock: true });
    if (!ticket) throw ticketNotFound();
    const actor = await linkingActor(tx, caller, ticket);
    // Held until the link is made, so a delete of the Artifact either went first, and it is unknown, or waits.
    if (isUuid(artifactId)) await tx.query("select 1 from artifacts where id = $1 for key share", [artifactId]);
    // An Artifact of another Workspace answers as unknown, even to a User who belongs to both.
    const artifact = await findArtifact(tx, caller, artifactId);
    if (!artifact || artifact.workspaceId !== ticket.workspaceId) {
      throw new ApiError(400, "unknown_artifact", "That Artifact isn't in this Workspace.");
    }
    return insertLink(context, tx, ticket, actor, artifact);
  });
}

/**
 * Links the Artifact to the Ticket and records it on the Ticket's timeline; refused for an Artifact of another
 * Project, and for one the Ticket already links.
 */
export async function insertLink(
  context: Context,
  tx: Tx,
  ticket: TicketRow,
  actor: ChangeActor,
  artifact: { id: string; projectId: string | null; title: string },
): Promise<LinkedArtifact> {
  if (artifact.projectId !== null && artifact.projectId !== ticket.projectId) {
    throw new ApiError(400, "artifact_outside_project", `${artifact.title} is in another Project.`, {
      rule: "A Ticket links Artifacts of its own Project or of the Workspace, not of another Project.",
      advice: `Link an Artifact of ${ticket.key}'s Project or of the Workspace, or mention the Artifact in a Comment.`,
    });
  }
  const { rowCount } = await tx.query(
    `insert into linked_artifacts (ticket_id, artifact_id, workspace_id, created_at) values ($1, $2, $3, $4)
     on conflict do nothing`,
    [ticket.id, artifact.id, ticket.workspaceId, context.clock.now()],
  );
  if (!rowCount) throw new ApiError(409, "artifact_already_linked", `${ticket.key} already links ${artifact.title}.`);
  const linked: LinkedArtifact = { id: artifact.id, projectId: artifact.projectId, title: artifact.title };
  await recordLinkChange(context, tx, ticket, actor, { from: null, to: { id: linked.id, title: linked.title } });
  return linked;
}

/** Unlinks an Artifact from the Ticket, by a User or by an Agent during its Run on it; the Artifact stays where it is kept. */
export async function unlinkArtifact(context: Context, caller: Caller, ticketId: string, artifactId: string): Promise<void> {
  await transaction(context.db, async (tx) => {
    const ticket = await findTicketRow(tx, caller, ticketId, { lock: true });
    if (!ticket) throw ticketNotFound();
    const actor = await linkingActor(tx, caller, ticket);
    const { rows } = isUuid(artifactId)
      ? await tx.query<LinkedArtifact>(
          `select ${columns} from ${fromLinks}
           where linked_artifacts.ticket_id = $1 and linked_artifacts.artifact_id = $2 for update of linked_artifacts`,
          [ticket.id, artifactId],
        )
      : { rows: [] };
    const unlinked = rows[0];
    if (!unlinked) throw new ApiError(404, "not_found", `${ticket.key} links no such Artifact.`);
    await tx.query("delete from linked_artifacts where ticket_id = $1 and artifact_id = $2", [ticket.id, unlinked.id]);
    await recordLinkChange(context, tx, ticket, actor, { from: { id: unlinked.id, title: unlinked.title }, to: null });
  });
}

/** Who links or unlinks: a User, or an Agent only during its own running Run on the Ticket, refused otherwise. */
async function linkingActor(tx: Tx, caller: Caller, ticket: TicketRow): Promise<ChangeActor> {
  if (caller.kind === "user") return caller.id;
  return { kind: "agent", id: caller.id, runId: await runOfAgent(tx, caller, ticket) };
}

/** An Artifact as a link's Change names it: its id, and its title then. */
type Named = { id: string; title: string };

/**
 * Records an Artifact linked (`to`) or unlinked (`from`) on the Ticket's timeline, named as it is titled now, and
 * tells the Workspace's live streams the Ticket changed.
 */
async function recordLinkChange(
  { clock, live }: Context,
  tx: Tx,
  ticket: TicketRow,
  actor: ChangeActor,
  change: { from: Named; to: null } | { from: null; to: Named },
): Promise<void> {
  await recordChanges(tx, ticket, actor, clock.now(), [{ field: "linkedArtifact", ...change }]);
  live.publish(tx, ticket.workspaceId, { type: "ticket.changed", projectId: ticket.projectId, ticketId: ticket.id });
}
