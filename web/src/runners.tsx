import { useCallback, useEffect, useState } from "react";
import { api, type ProjectSummary, type Runner, type WorkspaceSummary } from "./api.js";
import { field, useSubmit } from "./forms.js";
import { usePlace } from "./frame.js";
import { Actions, Banner, Button, EmptyState, Field, FormError, PageHead, Panel, Saved } from "./ui/controls.js";
import { Chip, ModelLabel } from "./ui/labels.js";

/**
 * The User's own Runners: ways for Cronk to start their Agents' Runs with their own credentials.
 * A subscription Runner fires one claude.ai scheduled task per model label, optionally per Project.
 */
export function RunnersScreen({ workspaces }: { workspaces: WorkspaceSummary[] }) {
  usePlace("runners");
  const [runners, setRunners] = useState<Runner[] | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    api.runners().then(setRunners, (e: Error) => setError(e.message));
  }, []);
  useEffect(refresh, [refresh]);
  useEffect(() => {
    Promise.all(workspaces.map((w) => api.projects(w.id))).then(
      (lists) => setProjects(lists.flat()),
      (e: Error) => setError(e.message),
    );
  }, [workspaces]);
  const replace = (updated: Runner) =>
    setRunners((all) => all?.map((r) => (r.id === updated.id ? updated : r)) ?? null);

  const create = useSubmit(async (form, element) => {
    await api.createRunner({ name: field(form, "name"), kind: "subscription" });
    element.reset();
    refresh();
  });

  return (
    <div className="page page-settings">
      <PageHead crumbs={[{ label: "Yours" }]} title="Runners" />
      <p className="muted">
        A Runner is how Cronk starts Runs of your Agents, spending your own credentials. A subscription Runner fires
        Claude Code on the web scheduled tasks: in claude.ai, create one task per model (for example triage on Haiku,
        implement on Opus) with an API trigger, and its prompt telling Claude to follow the instructions in the fire
        payload. Then save each task's trigger id and token here, and point your Agents at the Runner.
      </p>
      <FormError error={error} />
      {runners === null ? (
        <p className="muted">Loading…</p>
      ) : runners.length === 0 ? (
        <EmptyState title="No Runners yet.">Set one up below, then point your Agents at it from their pages.</EmptyState>
      ) : (
        runners.map((runner) => <RunnerSettings key={runner.id} runner={runner} projects={projects} onChanged={replace} />)
      )}
      <Panel title="Set up a Runner" id="new-runner">
        <form onSubmit={create.onSubmit}>
          <Field label="Runner name">
            <input name="name" required autoComplete="off" placeholder="Claude Max" />
          </Field>
          <FormError error={create.error} />
          <Actions>
            <Button type="submit" variant="primary" disabled={create.busy}>
              Set up a subscription Runner
            </Button>
          </Actions>
        </form>
      </Panel>
    </div>
  );
}

function RunnerSettings({
  runner,
  projects,
  onChanged,
}: {
  runner: Runner;
  projects: ProjectSummary[];
  onChanged: (runner: Runner) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [limitSaved, setLimitSaved] = useState(false);
  const limit = useSubmit(async (form) => {
    setLimitSaved(false);
    onChanged(await api.setRunnerLimit(runner.id, Number(field(form, "limit"))));
    setLimitSaved(true);
  });
  const save = useSubmit(async (form, element) => {
    const projectId = field(form, "projectId");
    onChanged(
      await api.saveTrigger(runner.id, {
        model: field(form, "model"),
        projectId: projectId || null,
        triggerId: field(form, "triggerId"),
        token: field(form, "token"),
      }),
    );
    element.reset();
  });
  const remove = async (triggerId: string) => {
    setError(null);
    try {
      onChanged(await api.removeTrigger(runner.id, triggerId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const projectName = (id: string | null) =>
    id === null ? "All Projects" : (projects.find((p) => p.id === id)?.name ?? "A Project you no longer see");

  return (
    <section aria-label={runner.name} className="panel runner">
      <header className="agent-card-head">
        <h2>{runner.name}</h2>
        <Chip>
          <span className="mono">{runner.kind}</span>
        </Chip>
        <span className="muted small">
          up to {runner.limit} Run{runner.limit === 1 ? "" : "s"} at once
        </span>
      </header>
      {runner.pausedUntil && (
        <Banner tone="warn" label="Paused">
          <p role="status">
            Rate limited: its queue is paused until {new Date(runner.pausedUntil).toLocaleString()}. Tickets waiting for it
            start once it resumes.
          </p>
        </Banner>
      )}
      <form onSubmit={limit.onSubmit}>
        <Field label="Runs at once">
          <input name="limit" type="number" min={1} max={100} required defaultValue={runner.limit} />
        </Field>
        <FormError error={limit.error} />
        <Actions>
          <Button type="submit" disabled={limit.busy}>
            Save limit
          </Button>
          <Saved shown={limitSaved} />
        </Actions>
      </form>
      {runner.kind === "subscription" && (
        <>
          <h3>Triggers</h3>
          <FormError error={error} />
          {runner.triggers.length === 0 ? (
            <p className="muted">No triggers yet: Runs on this Runner can't start until one is saved for their Step's model.</p>
          ) : (
            <table className="triggers">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Project</th>
                  <th>Trigger</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {runner.triggers.map((trigger) => (
                  <tr key={trigger.id}>
                    <td>
                      <ModelLabel model={trigger.model} />
                    </td>
                    <td>{projectName(trigger.projectId)}</td>
                    <td>
                      <code>{trigger.triggerId}</code>
                    </td>
                    <td className="cell-actions">
                      <Button variant="ghost" size="small" onClick={() => remove(trigger.id)}>
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <form onSubmit={save.onSubmit} aria-label="Save a trigger">
            <div className="form-row">
              <Field label="Model">
                <input name="model" required autoComplete="off" placeholder="haiku" className="mono" />
              </Field>
              <Field label="For">
                <select name="projectId" defaultValue="">
                  <option value="">All Projects</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} only
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="form-row">
              <Field label="Trigger id">
                <input name="triggerId" required autoComplete="off" placeholder="trig_01ABC…" className="mono" />
              </Field>
              <Field label="Trigger token">
                <input name="token" type="password" required autoComplete="off" />
              </Field>
            </div>
            <p className="field-hint">The token is stored encrypted and never shown again. Saving a model again replaces its trigger.</p>
            <FormError error={save.error} />
            <Actions>
              <Button type="submit" variant="primary" disabled={save.busy}>
                Save trigger
              </Button>
            </Actions>
          </form>
        </>
      )}
    </section>
  );
}
