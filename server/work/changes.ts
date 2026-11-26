import { Type, type Static } from "typebox";
import type { Db, Tx } from "../db.js";
import { inReach, type Viewer } from "../identity/viewers.js";
import { ActorOrCronk, actorOrCronkColumn } from "./actors.js";
import { literals } from "../literals.js";

/** Who made a Change: a User, an Agent, or Cronk itself, such as when it moves a Ticket on past a skipped Step. */
export const ChangedBy = ActorOrCronk;

/**
 * What a Change changed. `created` marks the Ticket's creation; for one imported from a GitHub issue it goes to
 * `{ source: "github", url, author }`, the issue's address and who opened it. `parent` is this Ticket's parent; `subTicket`,
 * `blocks`, `blockedBy`, `relatesTo`, `duplicateOf` and `duplicatedBy` each show one Ticket added (from null) or removed (to null). `stepSkipped`
 * marks Cronk passing the Ticket on past a Step it didn't pass, by its Label rule or as a Merge Step skipping itself,
 * before the `status` Change moving it. `dismissed` marks a
 * User dismissing a Discovered Ticket from their Inbox. `linkedDocument` shows one Document linked (from null) or
 * unlinked (to null), as `{ id, title }` titled then, and `linkedArtifact` one Artifact likewise. `merged` marks Cronk completing the Ticket for a merged Pull Request,
 * before the `status` and `verification` Changes moving it. `queueJoined` marks a User pressing Merge, queuing
 * one of its Pull Requests in the Merge Queue, before the `status` Change moving it into the Merge Status;
 * `queueLeft` marks it leaving the queue without being merged. `sentBack` marks Cronk sending the Ticket back for a failing check,
 * requested changes or a merge conflict on a Pull Request, before the `status` Change moving it. `transcriptDeleted` marks a User deleting
 * the Transcript of one of the Ticket's Runs, or of a session outside a Run that named the Ticket. `runStopped` marks
 * Cronk stopping the Ticket's running Run when nothing else about the Ticket changed, as when its Project is archived.
 * `archived` and `unarchived` mark a User, or an Agent with a Full token, archiving the Ticket and unarchiving it.
 * `release` shows the Ticket tagged with a Release (from null), untagged (to null) or moved between two, each as
 * `{ id, name }` named then.
 */
export const changeFields = [
  "created",
  "title",
  "description",
  "status",
  "priority",
  "labels",
  "assignee",
  "dueDate",
  "estimate",
  "release",
  "parent",
  "subTicket",
  "blocks",
  "blockedBy",
  "relatesTo",
  "duplicateOf",
  "duplicatedBy",
  "delegate",
  "stepSkipped",
  "autonomousDelegation",
  "verification",
  "dismissed",
  "linkedDocument",
  "linkedArtifact",
  "merged",
  "queueJoined",
  "queueLeft",
  "sentBack",
  "transcriptDeleted",
  "runStopped",
  "archived",
  "unarchived",
] as const;
export type ChangeField = (typeof changeFields)[number];

export const Change = Type.Object({
  id: Type.String({ format: "uuid" }),
  actor: ChangedBy,
  at: Type.String({ format: "date-time" }),
  field: literals(changeFields),
  from: Type.Unknown({
    description:
      "The value before: a string, number, boolean, list of Labels, for a Status, Assignee, Delegate or Release `{ id, name }` as named then, " +
      "or for another Ticket `{ id, projectId, key, title }` as it was then; null when empty. A `created` Change goes " +
      "from null to null, or for a Ticket imported from a GitHub issue to `{ source: \"github\", url, author }`, the issue's " +
      "address and who opened it: a User `{ id, name }` as named then, or `{ login }` for a GitHub account no User of the " +
      "Workspace had linked (absent for imports before authors were kept). A `stepSkipped` Change goes " +
      "from null to `{ status: { id, name }, labelRule, outcome }`: the Status whose Step was skipped, its Label rule " +
      "and the default Outcome the Ticket moved on by. A Merge Step that skipped itself records `labelRule` null and " +
      "`mergeRule` beside it: `agentsMayMergeOff` when its Project has agents may merge off, " +
      "`noAutonomousDelegation` when the Ticket has no Autonomous Delegation, otherwise `pullRequestAutomationOff`, " +
      "when its Project has Pull Request automation off. A `merged` Change goes from null to " +
      "`{ pullRequest: { id, repository, number, title, url }, mergedBy }`: the Pull Request as it was then and the " +
      "login of the GitHub account that merged it, or null when GitHub named none. A `queueJoined` Change goes from null " +
      "to `{ pullRequest: { id, repository, number, url } }`, the Pull Request queued in the Merge Queue, by the User " +
      "who pressed Merge or, for Autonomous Delegation, by Cronk; a `queueLeft` " +
      "Change goes from that to null, when it leaves the queue unmerged. A `sentBack` Change goes from null to " +
      "`{ pullRequest: { id, repository, number, url }, failure }`: the Pull Request and what failed on it: a check " +
      "`{ kind: \"check\", name, url }`, a review requesting changes `{ kind: \"review\", reviewer, url }`, the reviewer " +
      "being the login of the GitHub account that wrote it, or null when GitHub named none, or a conflict with its base branch " +
      "`{ kind: \"conflict\", branch, merge }`, `merge` being the merged Pull Request `{ repository, number, url }` that " +
      "caused it, or null when Cronk knows none; a `url` is null when GitHub gave none. " +
      "A `transcriptDeleted` Change goes from `{ runId, step, sessionId, agent: { id, name } }` to null: the Run whose " +
      "Transcript a User deleted and its Step's name (both null for a session outside a Run that named the Ticket), " +
      "its session and its Agent. A `runStopped` Change, Cronk's, goes from `{ runId, step, agent: { id, name }, why }` " +
      "to null: the Run Cronk stopped, its Step's name, its Agent and why, `projectArchived` when an Admin archived " +
      "the Ticket's Project.",
  }),
  to: Type.Unknown({ description: "The value after, in the same form as `from`." }),
  runId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
    description: "The Run an Agent made the Change in; null for a User's Change or Cronk's.",
  }),
});
export type Change = Static<typeof Change>;

export interface NewChange {
  field: ChangeField;
  from: unknown;
  to: unknown;
}

/** Who makes a Change: a User, by id, an Agent (during one of its Runs, or outside any), or Cronk itself. */
export type ChangeActor = string | { kind: "agent"; id: string; runId: string | null } | { kind: "cronk" };

export async function recordChanges(
  tx: Tx,
  ticket: { id: string; workspaceId: string },
  actor: ChangeActor,
  at: Date,
  changes: NewChange[],
): Promise<void> {
  const [userId, agentId, runId] =
    typeof actor === "string" ? [actor, null, null] : actor.kind === "agent" ? [null, actor.id, actor.runId] : [null, null, null];
  for (const change of changes) {
    await tx.query(
      `insert into changes (workspace_id, ticket_id, actor_user_id, actor_agent_id, run_id, at, field, from_value, to_value)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [ticket.workspaceId, ticket.id, userId, agentId, runId, at, change.field, json(change.from), json(change.to)],
    );
  }
}

// pg sends a JS array as a Postgres array, so jsonb values go as JSON text.
const json = (value: unknown) => (value === null ? null : JSON.stringify(value));

/**
 * A Ticket's Changes, oldest first, as the Viewer sees them: a Change naming a Ticket it can't read, such as a block
 * by a Ticket of a private Project, is left out, as if it didn't exist.
 */
export async function changesOf(db: Db, viewer: Viewer, ticketId: string): Promise<Change[]> {
  const named = (value: string) => {
    const project = `(case when jsonb_typeof(${value}) = 'object' then ${value} ->> 'projectId' end)::uuid`;
    const reach = inReach(viewer, { project, workspace: "changes.workspace_id" }, "$2");
    return `(${project} is null or ${reach.sql})`;
  };
  const { rows } = await db.query<Omit<Change, "at"> & { at: Date }>(
    `select changes.id,
       ${actorOrCronkColumn("users", "agents")} as actor,
       changes.at, changes.field,
       changes.from_value as from, changes.to_value as to, changes.run_id as "runId"
     from changes left join users on users.id = changes.actor_user_id
     left join agents on agents.id = changes.actor_agent_id
     where changes.ticket_id = $1 and ${named("changes.from_value")} and ${named("changes.to_value")}
     order by changes.seq`,
    [ticketId, inReach(viewer, { project: "null", workspace: "null" }, "$2").value],
  );
  return rows.map((row) => ({ ...row, at: row.at.toISOString() }));
}
