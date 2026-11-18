import { Type, type Static } from "typebox";
import type { Db, Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import type { StatusKind } from "./projects.js";

/** How many rounds a Step allows unless told otherwise. */
export const defaultRoundLimit = 2;

/** One of the named ways a Step's Run may end, moving the Ticket to a Status. */
export const Outcome = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 50, pattern: "\\S", description: "Unique within the Step, ignoring case." }),
  statusId: Type.String({ format: "uuid", description: "The Status of the same Project the Outcome moves the Ticket to." }),
  default: Type.Boolean({ description: "Where a skipped Step sends the Ticket. Exactly one Outcome is the default." }),
  needsYou: Type.Boolean({ description: "Hands the Ticket back to its Assignee with a Question. Exactly one Outcome is *needs you*." }),
  countsAsRound: Type.Boolean({ description: "Sends work back, counting toward the Step's round limit." }),
});
export type Outcome = Static<typeof Outcome>;

/** Which Tickets a Step lets through: only those with the Label, or only those without it. */
export const LabelRule = Type.Object(
  {
    kind: Type.Union([Type.Literal("requires"), Type.Literal("skippedBy")], {
      description: "`requires`: only Tickets with the Label pass. `skippedBy`: Tickets with the Label don't.",
    }),
    label: Type.String({ minLength: 1, maxLength: 50, pattern: "\\S", description: "Matched ignoring case." }),
  },
  { description: "A Ticket that doesn't pass gets no Run and moves on by the Step's default Outcome." },
);
export type LabelRule = Static<typeof LabelRule>;

/** The agent work a Status asks for: a Brief, the model it wants, a round limit, a Label rule and its Outcomes. */
export const Step = Type.Object({
  brief: Type.String({ description: "Markdown; the middle of the Brief a Run starts from." }),
  model: Type.String({ description: "The label of the model the Step wants, such as `haiku`, `sonnet` or `opus`." }),
  roundLimit: Type.Integer({ minimum: 0 }),
  labelRule: Type.Union([LabelRule, Type.Null()]),
  outcomes: Type.Array(Outcome),
});
export type Step = Static<typeof Step>;

/** Steps by the id of the Status they're on, for a Project. */
export async function stepsOf(db: Db | Tx, projectId: string): Promise<Map<string, Step>> {
  const { rows } = await db.query<Omit<Step, "outcomes"> & { statusId: string; outcomes: Outcome[] }>(
    `select steps.status_id as "statusId", steps.brief, steps.model, steps.round_limit as "roundLimit",
       case when steps.label_rule_kind is null then null else json_build_object(
         'kind', case steps.label_rule_kind when 'skipped_by' then 'skippedBy' else steps.label_rule_kind end,
         'label', steps.label_rule_label
       ) end as "labelRule",
       coalesce(json_agg(json_build_object(
         'name', outcomes.name, 'statusId', outcomes.status_id, 'default', outcomes.is_default,
         'needsYou', outcomes.needs_you, 'countsAsRound', outcomes.counts_as_round
       ) order by outcomes.position) filter (where outcomes.step_id is not null), '[]') as outcomes
     from steps left join outcomes on outcomes.step_id = steps.id
     where steps.project_id = $1
     group by steps.id`,
    [projectId],
  );
  return new Map(rows.map(({ statusId, ...step }) => [statusId, step]));
}

/** The rules a Step's Outcomes keep, checked against the Statuses of its Project. */
export function checkOutcomes(outcomes: Outcome[], statuses: { id: string; name: string; kind: StatusKind }[]): void {
  const names = new Set<string>();
  for (const { name } of outcomes) {
    if (names.has(name.toLowerCase())) {
      throw new ApiError(400, "outcome_name_taken", `This Step already has an Outcome called ${name}.`);
    }
    names.add(name.toLowerCase());
  }
  for (const { name, statusId } of outcomes) {
    if (!statuses.some((s) => s.id === statusId)) {
      throw new ApiError(400, "unknown_status", `The Outcome ${name} moves Tickets to a Status that isn't in this Project.`);
    }
  }
  exactlyOne(outcomes.filter((o) => o.default), "default", "default_outcome_needed");
  exactlyOne(outcomes.filter((o) => o.needsYou), "needs you", "needs_you_outcome_needed");
  const both = outcomes.find((o) => o.default && o.needsYou);
  if (both) {
    throw new ApiError(
      400,
      "outcome_default_and_needs_you",
      `${both.name} can't be both the default Outcome and the needs you Outcome: make them two Outcomes.`,
    );
  }
  for (const outcome of outcomes) {
    const target = statuses.find((s) => s.id === outcome.statusId)!;
    const refusal = targetRefusal(outcome, target.kind);
    if (refusal) {
      throw new ApiError(
        409,
        "outcome_target_not_allowed",
        `The ${refusal.role} ${outcome.name} can't move Tickets to ${target.name}, a ${refusal.kind} Status: ${refusal.why}.`,
      );
    }
  }
}

function exactlyOne(found: Outcome[], role: string, code: string): void {
  if (found.length === 1) return;
  const has = found.length === 0 ? "none" : `${found.length}: ${found.map((o) => o.name).join(" and ")}`;
  throw new ApiError(400, code, `A Step needs exactly one ${role} Outcome, and this one has ${has}.`);
}

/**
 * Why an Outcome may not move Tickets to a Status of the given kind, if it may not:
 * skipping a Step or asking a User must never complete or cancel work, and agents never cancel it.
 */
export function targetRefusal(
  outcome: Pick<Outcome, "default" | "needsYou">,
  targetKind: StatusKind,
): { role: string; kind: string; why: string } | undefined {
  const kind = targetKind === "done" ? "Done" : targetKind === "canceled" ? "Canceled" : undefined;
  if (!kind) return undefined;
  if (outcome.default) return { role: "default Outcome", kind, why: "skipping a Step must never complete work" };
  if (outcome.needsYou) return { role: "needs you Outcome", kind, why: "asking a User must never complete work" };
  if (kind === "Canceled") return { role: "Outcome", kind, why: "agents never cancel work" };
  return undefined;
}

/** Puts a Step on a Status, replacing any Step it had; the Step is checked by the caller. */
export async function writeStep(
  tx: Tx,
  project: { id: string; workspaceId: string },
  statusId: string,
  step: Step,
  now: Date,
): Promise<void> {
  const { rows } = await tx.query<{ id: string }>(
    `insert into steps (workspace_id, project_id, status_id, brief, model, round_limit, label_rule_kind, label_rule_label,
       created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (status_id) do update set brief = excluded.brief, model = excluded.model, round_limit = excluded.round_limit,
       label_rule_kind = excluded.label_rule_kind, label_rule_label = excluded.label_rule_label
     returning id`,
    [
      project.workspaceId,
      project.id,
      statusId,
      step.brief,
      step.model,
      step.roundLimit,
      step.labelRule && (step.labelRule.kind === "skippedBy" ? "skipped_by" : "requires"),
      step.labelRule?.label.trim() ?? null,
      now,
    ],
  );
  const stepId = rows[0]!.id;
  await tx.query("delete from outcomes where step_id = $1", [stepId]);
  for (const [position, outcome] of step.outcomes.entries()) {
    await tx.query(
      `insert into outcomes (step_id, project_id, position, name, status_id, is_default, needs_you, counts_as_round)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [stepId, project.id, position, outcome.name, outcome.statusId, outcome.default, outcome.needsYou, outcome.countsAsRound],
    );
  }
}

/** Every Outcome of a Project's Steps, with the Status its Step is on, in board order. */
export async function outcomesOf(
  db: Db | Tx,
  projectId: string,
): Promise<(Outcome & { stepStatusId: string })[]> {
  const { rows } = await db.query<Outcome & { stepStatusId: string }>(
    `select steps.status_id as "stepStatusId", outcomes.name, outcomes.status_id as "statusId",
       outcomes.is_default as default, outcomes.needs_you as "needsYou", outcomes.counts_as_round as "countsAsRound"
     from outcomes join steps on steps.id = outcomes.step_id join statuses on statuses.id = steps.status_id
     where steps.project_id = $1
     order by statuses.position, outcomes.position`,
    [projectId],
  );
  return rows;
}

/** Takes the Step off a Status, which then waits for a User. */
export async function removeStep(tx: Tx, statusId: string): Promise<void> {
  await tx.query("delete from steps where status_id = $1", [statusId]);
}
