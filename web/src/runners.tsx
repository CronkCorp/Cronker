import { useCallback, useEffect, useState } from "react";
import { api, type ProjectSummary, type Runner, type WorkspaceSummary } from "./api.js";
import { field, useSubmit } from "./forms.js";

/**
 * The User's own Runners: ways for Cronk to start their Agents' Runs with their own credentials.
 * A subscription Runner fires one claude.ai scheduled task per model label, optionally per Project.
 */
export function RunnersScreen({ workspaces }: { workspaces: WorkspaceSummary[] }) {
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
    <section>
      <h1>Runners</h1>
      <p>
        A Runner is how Cronk starts Runs of your Agents, spending your own credentials. A subscription Runner fires
        Claude Code on the web scheduled tasks: in claude.ai, create one task per model (for example triage on Haiku,
        implement on Opus) with an API trigger, and its prompt telling Claude to follow the instructions in the fire
        payload. Then save each task's trigger id and token here, and point your Agents at the Runner.
      </p>
      <div className="admin-forms">
        <form onSubmit={create.onSubmit}>
          <label>
            Runner name
            <input name="name" required autoComplete="off" placeholder="Claude Max" />
          </label>
          {create.error && <p role="alert">{create.error}</p>}
          <button type="submit" disabled={create.busy}>
            Set up a subscription Runner
          </button>
        </form>
      </div>
      {error && <p role="alert">{error}</p>}
      {runners === null ? (
        <p>Loading…</p>
      ) : runners.length === 0 ? (
        <p>No Runners yet.</p>
      ) : (
        runners.map((runner) => (
          <RunnerSettings key={runner.id} runner={runner} projects={projects} onChanged={replace} />
        ))
      )}
    </section>
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
  const limit = useSubmit(async (form) => {
    onChanged(await api.setRunnerLimit(runner.id, Number(field(form, "limit"))));
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
    <section aria-label={runner.name} className="runner">
      <h2>
        {runner.name} <small>({runner.kind})</small>
      </h2>
      {runner.pausedUntil && (
        <p role="status">Rate limited: its queue is paused until {new Date(runner.pausedUntil).toLocaleString()}.</p>
      )}
      <div className="admin-forms">
        <form onSubmit={limit.onSubmit}>
          <label>
            Runs at once
            <input name="limit" type="number" min={1} max={100} required defaultValue={runner.limit} />
          </label>
          {limit.error && <p role="alert">{limit.error}</p>}
          <button type="submit" disabled={limit.busy}>
            Save limit
          </button>
        </form>
        {runner.kind === "subscription" && (
          <form onSubmit={save.onSubmit} aria-label="Save a trigger">
            <label>
              Model
              <input name="model" required autoComplete="off" placeholder="haiku" />
            </label>
            <label>
              For
              <select name="projectId" defaultValue="">
                <option value="">All Projects</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} only
                  </option>
                ))}
              </select>
            </label>
            <label>
              Trigger id
              <input name="triggerId" required autoComplete="off" placeholder="trig_01ABC…" />
            </label>
            <label>
              Trigger token
              <input name="token" type="password" required autoComplete="off" />
            </label>
            <small>
              The token is stored encrypted and never shown again. Saving a model again replaces its trigger.
            </small>
            {save.error && <p role="alert">{save.error}</p>}
            <button type="submit" disabled={save.busy}>
              Save trigger
            </button>
          </form>
        )}
      </div>
      {runner.kind === "subscription" && (
        <>
          <h3>Triggers</h3>
          {error && <p role="alert">{error}</p>}
          {runner.triggers.length === 0 ? (
            <p>No triggers yet: Runs on this Runner can't start until one is saved for their Step's model.</p>
          ) : (
            <table>
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
                    <td>{trigger.model}</td>
                    <td>{projectName(trigger.projectId)}</td>
                    <td>
                      <code>{trigger.triggerId}</code>
                    </td>
                    <td className="actions">
                      <button type="button" onClick={() => remove(trigger.id)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
