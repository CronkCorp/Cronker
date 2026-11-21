import { useEffect, useState } from "react";
import { api, type ModelId } from "./api.js";
import { field, useSubmit } from "./forms.js";
import { Actions, Button, Field, FormError, Panel, Saved } from "./ui/controls.js";
import { ModelLabel } from "./ui/labels.js";

/** The Workspace's model ids, in its Settings: each label with its model id, and a form setting one, for Admins. */
export function ModelIdsPanel({ workspaceId }: { workspaceId: string }) {
  const [modelIds, setModelIds] = useState<ModelId[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const reload = () => api.modelIds(workspaceId).then(setModelIds, (e: Error) => setFailure(e.message));
  useEffect(() => {
    void reload();
  }, [workspaceId]);
  const save = useSubmit(async (form, element) => {
    setSaved(false);
    await api.saveModelId(workspaceId, field(form, "label").trim(), field(form, "modelId"));
    element.reset();
    await reload();
    setSaved(true);
  });
  const remove = async (label: string) => {
    setSaved(false);
    setFailure(null);
    try {
      await api.removeModelId(workspaceId, label);
      await reload();
      setSaved(true);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Panel
      title="Model ids"
      id="model-ids"
      description="The exact model each model label stands for, so a Runner setup gives each routine the model its Steps want."
    >
      <div className="model-ids">
        {modelIds && modelIds.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Model label</th>
                <th>Model id</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {modelIds.map((entry) => (
                <tr key={entry.label}>
                  <td>
                    <ModelLabel model={entry.label} />
                  </td>
                  <td>
                    <code>{entry.modelId}</code>
                  </td>
                  <td className="cell-actions">
                    <div>
                      <Button variant="ghost" size="small" onClick={() => void remove(entry.label)} aria-label={`Remove the ${entry.label} model label`}>
                        Remove
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {modelIds && modelIds.length === 0 && <p className="muted small">No model ids yet.</p>}
        <FormError error={failure} />
        <form onSubmit={save.onSubmit} aria-label="Set a model id" className="model-ids-form">
          <div className="form-row">
            <Field label="Model label">
              <input name="label" required maxLength={50} autoComplete="off" placeholder="opus" className="mono" />
            </Field>
            <Field label="Model id">
              <input name="modelId" required maxLength={200} autoComplete="off" placeholder="claude-opus-5-5" className="mono" />
            </Field>
          </div>
          <p className="field-hint">Model labels match ignoring case, so setting one again changes its model id.</p>
          <FormError error={save.error} />
          <Actions>
            <Button type="submit" variant="primary" disabled={save.busy}>
              Set model id
            </Button>
            <Saved shown={saved} />
          </Actions>
        </form>
      </div>
    </Panel>
  );
}
