import { Type } from "typebox";
import { transaction, type Db } from "../db.js";
import { ApiError } from "../http/errors.js";
import { ModelId, mostModelLabels } from "./workspaces.js";

/** A model label, as Steps use it, such as `haiku`: what a trigger and a model id are saved under. Trimmed before use. */
export const ModelLabel = Type.String({ minLength: 1, maxLength: 50, pattern: "\\S", description: "The model label, such as `haiku`." });

/** The model ids of a Workspace, in its own order: the same list its settings carry as `modelIds`. */
export async function modelIdsOf(db: Db, workspaceId: string): Promise<ModelId[]> {
  const { rows } = await db.query<{ modelIds: ModelId[] }>(`select model_ids as "modelIds" from workspaces where id = $1`, [workspaceId]);
  return rows[0]!.modelIds;
}

/**
 * Changes the Workspace's model ids one label at a time, locking them so two changes at once both count. The list
 * keeps its order: a label it already has, matched ignoring case, is changed where it is.
 */
async function changeModelIds(db: Db, workspaceId: string, change: (modelIds: ModelId[]) => ModelId[]): Promise<void> {
  await transaction(db, async (tx) => {
    const { rows } = await tx.query<{ modelIds: ModelId[] }>(
      `select model_ids as "modelIds" from workspaces where id = $1 for update`,
      [workspaceId],
    );
    const modelIds = change(rows[0]!.modelIds);
    await tx.query("update workspaces set model_ids = $2 where id = $1", [workspaceId, JSON.stringify(modelIds)]);
  });
}

const matches = (label: string) => (entry: ModelId) => entry.label.toLowerCase() === label.toLowerCase();

/** Sets the model id a label stands for: changes the label matching it ignoring case, which takes this spelling, or adds it last. */
export async function saveModelId(db: Db, workspaceId: string, label: string, modelId: string): Promise<ModelId> {
  const saved = { label: label.trim(), modelId: modelId.trim() };
  await changeModelIds(db, workspaceId, (modelIds) => {
    const at = modelIds.findIndex(matches(saved.label));
    if (at >= 0) return modelIds.map((entry, i) => (i === at ? saved : entry));
    if (modelIds.length >= mostModelLabels) {
      throw new ApiError(400, "too_many_model_labels", `A Workspace has at most ${mostModelLabels} model labels: remove one first.`);
    }
    return [...modelIds, saved];
  });
  return saved;
}

/** Removes the label matching this one ignoring case; 404 if the Workspace has none. */
export async function removeModelId(db: Db, workspaceId: string, label: string): Promise<void> {
  await changeModelIds(db, workspaceId, (modelIds) => {
    const kept = modelIds.filter((entry) => !matches(label.trim())(entry));
    if (kept.length === modelIds.length) throw new ApiError(404, "not_found", "This Workspace has no model id for that label.");
    return kept;
  });
}
