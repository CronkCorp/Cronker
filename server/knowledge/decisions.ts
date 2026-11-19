import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { transaction, type Db, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import type { Live } from "../live/live.js";
import { isUuid } from "../http/ids.js";
import { ownerName } from "../agents/tokens.js";
import type { Caller } from "../identity/callers.js";
import { inView, type Viewer } from "../identity/viewers.js";
import { Actor, actorColumn } from "../work/actors.js";
import { ComparedLine, compareLines } from "./compare.js";
import type { Place } from "./places.js";
import { outdatedVersion } from "./versions.js";

/**
 * Decisions: recorded choices with their reasoning and a status, of a Project or of the Workspace, numbered in
 * order of creation in each. Each save makes a Version recording its Actor. Never deleted.
 */

export const statuses = ["proposed", "accepted", "rejected", "deprecated", "superseded"] as const;
export const DecisionStatus = Type.Union(
  statuses.map((status) => Type.Literal(status)),
  { description: "Agents propose Decisions; only a User changes their status." },
);
export type DecisionStatus = (typeof statuses)[number];

const SupersededById = Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
  description: "The Decision replacing it, in the same Project or both in the Workspace; set only while superseded.",
});

/** One saved state of a Decision, without its body. */
export const DecisionVersion = Type.Object({
  number: Type.Integer({ minimum: 1, description: "Counts up from 1 with each save of the Decision." }),
  title: Type.String(),
  status: DecisionStatus,
  supersededById: SupersededById,
  actor: Actor,
  savedAt: Type.String({ format: "date-time" }),
});
export type DecisionVersion = Static<typeof DecisionVersion>;

export const Decision = Type.Object({
  id: Type.String({ format: "uuid" }),
  workspaceId: Type.String({ format: "uuid" }),
  projectId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
    description: "The Project it belongs to, or null for the Workspace's own.",
  }),
  number: Type.Integer({
    minimum: 1,
    description: "Counts up from 1 in order of creation, separately for each Project and for the Workspace.",
  }),
  title: Type.String(),
  body: Type.String({ description: "Markdown: the choice and its reasoning." }),
  status: DecisionStatus,
  supersededById: SupersededById,
  version: Type.Object(DecisionVersion.properties, { description: "The current Version, which a save names as its base." }),
});
export type Decision = Static<typeof Decision>;


type Row = Omit<Decision, "version"> & { version: DecisionVersion };

const columns = `decisions.id, decisions.workspace_id as "workspaceId", decisions.project_id as "projectId",
  decisions.number, versions.title, versions.body, versions.status, versions.superseded_by_id as "supersededById",
  json_build_object('number', versions.number, 'title', versions.title, 'status', versions.status,
    'supersededById', versions.superseded_by_id, 'actor', ${actorColumn("users", "agents")},
    'savedAt', versions.saved_at) as version`;

const fromDecisions = `decisions
  join decision_versions versions on versions.decision_id = decisions.id and versions.number = decisions.version
  left join users on users.id = versions.actor_user_id
  left join agents on agents.id = versions.actor_agent_id`;

const present = (row: Row): Decision => ({
  ...row,
  version: { ...row.version, savedAt: new Date(row.version.savedAt).toISOString() },
});

/** A Decision in the Viewer's view; otherwise nothing, as if it didn't exist. */
export async function findDecision(db: Db | Tx, viewer: Viewer, decisionId: string): Promise<Decision | undefined> {
  if (!isUuid(decisionId)) return undefined;
  const view = inView(viewer, "decisions.workspace_id", "$2");
  const { rows } = await db.query<Row>(`select ${columns} from ${fromDecisions} where decisions.id = $1 and ${view.sql}`, [
    decisionId,
    view.value,
  ]);
  return rows[0] && present(rows[0]);
}

export function decisionNotFound(): ApiError {
  return new ApiError(404, "not_found", "No such Decision.");
}

/** Holds the scope's new Decisions in this transaction, so their numbers count up one by one. */
async function lockScope(tx: Tx, scope: Place): Promise<void> {
  await tx.query("select pg_advisory_xact_lock(hashtext('decisions ' || $1 || ' ' || $2))", [
    scope.workspaceId,
    scope.projectId ?? "workspace",
  ]);
}

interface Content {
  title: string;
  body: string;
  status: DecisionStatus;
  supersededById: string | null;
}

async function insertVersion(
  tx: Tx,
  decision: { id: string; workspaceId: string },
  number: number,
  content: Content,
  actor: Caller,
  now: Date,
): Promise<void> {
  await tx.query(
    `insert into decision_versions (decision_id, number, workspace_id, title, body, status, superseded_by_id,
       actor_user_id, actor_agent_id, saved_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      decision.id,
      number,
      decision.workspaceId,
      content.title.trim(),
      content.body,
      content.status,
      content.supersededById,
      actor.kind === "user" ? actor.id : null,
      actor.kind === "agent" ? actor.id : null,
      now,
    ],
  );
}

/** A Decision's status, and the Decision replacing it while superseded. */
type StatusWithReplacement = Pick<Content, "status" | "supersededById">;

/** Refuses an Agent changing a Decision's status or what supersedes it, which only a User does. */
function requireStatusRight(actor: Caller, from: StatusWithReplacement, to: StatusWithReplacement): void {
  if (actor.kind !== "agent" || (from.status === to.status && from.supersededById === to.supersededById)) return;
  throw new ApiError(403, "agent_not_allowed", `${actor.name} is an Agent, and only a User changes a Decision's status.`, {
    rule: "Agents propose Decisions and edit their text; only a User changes a Decision's status.",
    advice: `Leave the status as it is, and argue for the change in the Decision's text, or ask ${ownerName(actor)}, ${actor.name}'s Owner, to change it.`,
  });
}

/**
 * The status a save asks for, with the Decision replacing it: named, or kept from before, while superseded, and
 * none otherwise. Refused when superseded names no replacing Decision, when another status names one, and when
 * the replacing Decision isn't another of the same Project, or of the Workspace's own for one of the Workspace's.
 */
function statusAsked(
  current: StatusWithReplacement | null,
  edit: { status?: DecisionStatus; supersededById?: string | null },
): StatusWithReplacement {
  const status = edit.status ?? current?.status ?? "proposed";
  if (status !== "superseded") {
    if (edit.supersededById) {
      throw new ApiError(400, "superseding_decision_unexpected", "Only a superseded Decision names the Decision replacing it.", {
        rule: "A Decision names the Decision replacing it only while superseded.",
        advice: "Leave `supersededById` out, or set the status to superseded.",
      });
    }
    return { status, supersededById: null };
  }
  const supersededById =
    edit.supersededById !== undefined ? edit.supersededById : current?.status === "superseded" ? current.supersededById : null;
  if (!supersededById) {
    throw new ApiError(400, "superseding_decision_needed", "A superseded Decision names the Decision replacing it.", {
      rule: "Superseded names the Decision that replaces it, so the chain of reasoning stays whole.",
      advice: "Give the replacing Decision's id as `supersededById`; record it first if it doesn't exist yet.",
    });
  }
  return { status, supersededById };
}

/** Refuses a replacing Decision that is the Decision itself, or not another of its own Project or the Workspace's. */
async function requireReplacementInScope(
  tx: Tx,
  decision: Place & { id: string | null },
  asked: StatusWithReplacement,
): Promise<void> {
  const replacement = asked.supersededById;
  if (!replacement) return;
  if (replacement === decision.id) {
    throw new ApiError(409, "superseding_decision_itself", "A Decision can't supersede itself.", {
      rule: "Superseded names another Decision that replaces it.",
      advice: "Name the Decision that replaces this one, recording it first if it doesn't exist yet.",
    });
  }
  const { rowCount } = isUuid(replacement)
    ? await tx.query("select 1 from decisions where id = $1 and workspace_id = $2 and project_id is not distinct from $3", [
        replacement,
        decision.workspaceId,
        decision.projectId,
      ])
    : { rowCount: 0 };
  if (rowCount === 0) {
    throw new ApiError(
      409,
      "superseding_decision_outside_scope",
      decision.projectId
        ? "The replacing Decision must be one of the same Project's."
        : "The replacing Decision must be one of the Workspace's own.",
      {
        rule: "A Decision is superseded by one in the same Project, or both are the Workspace's own, so no export names a Decision it lacks.",
        advice: "List the Decisions of the same Project, or of the Workspace, and name one of them; record it there first if need be.",
      },
    );
  }
}

/** Tells the Workspace's streams that a Decision was recorded or saved, so its register shows it. */
function decisionChanged(live: Live, tx: Tx, decision: Place & { id: string }): void {
  live.publish(tx, decision.workspaceId, { type: "decision.changed", projectId: decision.projectId, decisionId: decision.id });
}

/**
 * Records a Decision in the scope, numbered next in it, at Version 1 by its Actor: proposed, unless a User records
 * it with another status.
 */
export async function createDecision(
  { db, clock, live }: Context,
  actor: Caller,
  scope: Place,
  input: { title: string; body: string; status?: DecisionStatus; supersededById?: string | null },
): Promise<Decision> {
  const asked = statusAsked(null, input);
  requireStatusRight(actor, { status: "proposed", supersededById: null }, asked);
  return transaction(db, async (tx) => {
    await lockScope(tx, scope);
    await requireReplacementInScope(tx, { ...scope, id: null }, asked);
    const now = clock.now();
    const { rows } = await tx.query<{ id: string }>(
      `insert into decisions (workspace_id, project_id, number, version, created_at)
       select $1, $2, coalesce(max(number), 0) + 1, 1, $3 from decisions
       where workspace_id = $1 and project_id is not distinct from $2
       returning id`,
      [scope.workspaceId, scope.projectId, now],
    );
    const id = rows[0]!.id;
    const content: Content = { title: input.title, body: input.body, ...asked };
    await insertVersion(tx, { id, workspaceId: scope.workspaceId }, 1, content, actor, now);
    decisionChanged(live, tx, { ...scope, id });
    return (await findDecision(tx, actor, id))!;
  });
}

export const DecisionSummary = Type.Omit(Decision, ["body"]);
export type DecisionSummary = Static<typeof DecisionSummary>;

/** The scope's Decisions by number, with their bodies. */
export async function decisionsWithBodiesOf(db: Db, scope: Place): Promise<Decision[]> {
  const { rows } = await db.query<Row>(
    `select ${columns} from ${fromDecisions}
     where decisions.workspace_id = $1 and decisions.project_id is not distinct from $2
     order by decisions.number`,
    [scope.workspaceId, scope.projectId],
  );
  return rows.map(present);
}

/** The scope's Decisions by number, without their bodies. */
export async function decisionsOf(db: Db, scope: Place): Promise<DecisionSummary[]> {
  return (await decisionsWithBodiesOf(db, scope)).map(({ body: _body, ...summary }) => summary);
}

/** One saved state of a Decision with its body. */
export const DecisionVersionWithBody = Type.Object({
  ...DecisionVersion.properties,
  body: Type.String({ description: "Markdown." }),
});
export type DecisionVersionWithBody = Static<typeof DecisionVersionWithBody>;

type VersionRow = Omit<DecisionVersionWithBody, "savedAt"> & { savedAt: Date };

const versionColumns = `versions.number, versions.title, versions.body, versions.status,
  versions.superseded_by_id as "supersededById", ${actorColumn("users", "agents")} as actor, versions.saved_at as "savedAt"`;

const fromVersions = `decision_versions versions
  left join users on users.id = versions.actor_user_id
  left join agents on agents.id = versions.actor_agent_id`;

const presentVersion = (row: VersionRow): DecisionVersionWithBody => ({ ...row, savedAt: row.savedAt.toISOString() });

async function versionOf(db: Db | Tx, decisionId: string, number: number): Promise<DecisionVersionWithBody | undefined> {
  const { rows } = await db.query<VersionRow>(
    `select ${versionColumns} from ${fromVersions} where versions.decision_id = $1 and versions.number = $2`,
    [decisionId, number],
  );
  return rows[0] && presentVersion(rows[0]);
}

/** A Decision as a save needs it, its row locked until the transaction ends, so saves to it queue up. */
async function lockDecision(tx: Tx, viewer: Viewer, decisionId: string): Promise<(Place & { id: string; version: number }) | undefined> {
  if (!isUuid(decisionId)) return undefined;
  const view = inView(viewer, "decisions.workspace_id", "$2");
  const { rows } = await tx.query<Place & { id: string; version: number }>(
    `select id, workspace_id as "workspaceId", project_id as "projectId", version from decisions
     where id = $1 and ${view.sql} for update`,
    [decisionId, view.value],
  );
  return rows[0];
}

export interface DecisionEdit {
  /** The number of the Version the save is based on. */
  baseVersion?: number;
  title?: string;
  body?: string;
  status?: DecisionStatus;
  /** The Decision replacing it, while superseded. */
  supersededById?: string | null;
}

/**
 * Saves a Decision as its next Version by the Actor; a save that changes nothing makes no Version. A save must be
 * based on the current Version: one based on an outdated Version is refused with the current one, so its Actor can
 * see what changed.
 */
export async function editDecision(
  { db, clock, live }: Context,
  actor: Caller,
  decisionId: string,
  edit: DecisionEdit,
): Promise<Decision> {
  return transaction(db, async (tx) => {
    const decision = await lockDecision(tx, actor, decisionId);
    if (!decision) throw decisionNotFound();
    const current = (await versionOf(tx, decision.id, decision.version))!;
    const asked = statusAsked(current, edit);
    requireStatusRight(actor, current, asked);
    if (edit.baseVersion === undefined) {
      throw new ApiError(400, "base_version_needed", "A save names the Version it's based on, as `baseVersion`.", {
        rule: "A save names the Version it's based on, so it never overwrites a change its Actor hasn't seen.",
        advice: "Read the Decision and save again with `baseVersion` set to its current Version's number.",
      });
    }
    if (edit.baseVersion !== current.number) {
      throw outdatedVersion("Decision", current, edit.baseVersion);
    }
    await requireReplacementInScope(tx, decision, asked);
    const number = current.number + 1;
    const content: Content = { title: edit.title ?? current.title, body: edit.body ?? current.body, ...asked };
    const unchanged = (Object.keys(content) as (keyof Content)[]).every((key) =>
      key === "title" ? content.title.trim() === current.title : content[key] === current[key],
    );
    if (unchanged) return (await findDecision(tx, actor, decision.id))!;
    await insertVersion(tx, decision, number, content, actor, clock.now());
    await tx.query("update decisions set version = $2 where id = $1", [decision.id, number]);
    decisionChanged(live, tx, decision);
    return (await findDecision(tx, actor, decision.id))!;
  });
}

/** A Decision's Versions, oldest first, without their bodies. */
export async function decisionVersionsOf(db: Db, viewer: Viewer, decisionId: string): Promise<DecisionVersion[]> {
  const decision = await findDecision(db, viewer, decisionId);
  if (!decision) throw decisionNotFound();
  const { rows } = await db.query<VersionRow>(
    `select ${versionColumns} from ${fromVersions} where versions.decision_id = $1 order by versions.number`,
    [decision.id],
  );
  return rows.map(({ body: _body, ...row }) => ({ ...row, savedAt: row.savedAt.toISOString() }));
}

/** One of a Decision's Versions, with its body. */
export async function readDecisionVersion(
  db: Db,
  viewer: Viewer,
  decisionId: string,
  number: number,
): Promise<DecisionVersionWithBody> {
  const decision = await findDecision(db, viewer, decisionId);
  if (!decision) throw decisionNotFound();
  const version = await versionOf(db, decision.id, number);
  if (!version) throw new ApiError(404, "not_found", `Decision ${decision.number} has no Version ${number}.`);
  return version;
}

export const DecisionComparison = Type.Object({
  from: DecisionVersionWithBody,
  to: DecisionVersionWithBody,
  lines: Type.Array(ComparedLine, { description: "The bodies compared line by line, in order." }),
});
export type DecisionComparison = Static<typeof DecisionComparison>;

/** Two of a Decision's Versions, their bodies compared line by line. */
export async function compareDecisionVersions(
  db: Db,
  viewer: Viewer,
  decisionId: string,
  numbers: { from: number; to: number },
): Promise<DecisionComparison> {
  const from = await readDecisionVersion(db, viewer, decisionId, numbers.from);
  const to = await readDecisionVersion(db, viewer, decisionId, numbers.to);
  return { from, to, lines: compareLines(from.body, to.body) };
}

/** Refuses deleting a Decision, which nobody does: its status records that it no longer holds. */
export async function deleteDecision(db: Db, viewer: Viewer, decisionId: string): Promise<never> {
  const decision = await findDecision(db, viewer, decisionId);
  if (!decision) throw decisionNotFound();
  throw new ApiError(405, "decision_not_deletable", `Decision ${decision.number} can't be deleted; no Decision is.`, {
    rule: "Decisions are never deleted, so their history stays.",
    advice:
      viewer.kind === "agent"
        ? "Leave the Decision in place; a User may mark it rejected, deprecated or superseded instead."
        : "Mark it rejected, deprecated or superseded instead.",
  });
}
