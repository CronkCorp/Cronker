import { Type, type Static } from "typebox";
import type { Db } from "../db.js";
import { ApiError } from "../http/errors.js";

/**
 * One entry of a Workspace's model ids: the exact model id a model label, as Steps use it, stands for, so a Runner
 * setup knows which model each routine gets. New Workspaces start with the latest model of each family for `haiku`,
 * `sonnet` and `opus`.
 */
export const ModelId = Type.Object({
  label: Type.String({ description: "The model label, as Steps use it; matched ignoring case." }),
  modelId: Type.String({ description: "The exact model id, such as `claude-opus-5-5`." }),
});
export type ModelId = Static<typeof ModelId>;

export async function modelIdsOf(db: Db, workspaceId: string): Promise<ModelId[]> {
  const { rows } = await db.query<ModelId>(
    `select label, model_id as "modelId" from workspace_model_ids where workspace_id = $1 order by lower(label), label`,
    [workspaceId],
  );
  return rows;
}

/** A model label, as Steps use it, such as `haiku`; the same as a trigger's. */
export const ModelLabel = Type.String({ minLength: 1, maxLength: 50, pattern: "\\S", description: "The model label, such as `haiku`." });

export const ModelIdValue = Type.String({ minLength: 1, maxLength: 200, pattern: "\\S", description: "The exact model id, such as `claude-opus-5-5`." });

/** Sets the model id a label stands for, adding the label or changing the one that matches it ignoring case, whose spelling it takes. */
export async function saveModelId(db: Db, workspaceId: string, label: string, modelId: string): Promise<ModelId> {
  const { rows } = await db.query<ModelId>(
    `insert into workspace_model_ids (workspace_id, label, model_id) values ($1, $2, $3)
     on conflict (workspace_id, lower(label)) do update set label = excluded.label, model_id = excluded.model_id
     returning label, model_id as "modelId"`,
    [workspaceId, label.trim(), modelId.trim()],
  );
  return rows[0]!;
}

/** Removes the label matching this one ignoring case; 404 if the Workspace has none. */
export async function removeModelId(db: Db, workspaceId: string, label: string): Promise<void> {
  const { rowCount } = await db.query("delete from workspace_model_ids where workspace_id = $1 and lower(label) = lower($2)", [
    workspaceId,
    label.trim(),
  ]);
  if (!rowCount) throw new ApiError(404, "not_found", "This Workspace has no model id for that label.");
}
