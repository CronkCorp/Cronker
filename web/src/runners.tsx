import { useCallback, useEffect, useState } from "react";
import {
  api,
  type Agent,
  type AgentToken,
  type ProjectSummary,
  type Runner,
  type StartedSetup,
  type TranscriptHook,
  type Trigger,
  type WorkspaceSummary,
} from "./api.js";
import { field, useSubmit } from "./forms.js";
import { usePlace } from "./frame.js";
import { useLatest, useRunnerEvents } from "./live.js";
import { Actions, Banner, Button, clockTime, CopyButton, dayShown, EmptyState, Field, FormError, PageHead, Panel, RunnersLiveIndicator, Saved, ShownOnce } from "./ui/controls.js";
import { ConfirmDialog, Dialog, DialogActions, DialogClose, Menu, MenuItem } from "./ui/overlays.js";
import { Chip, ModelLabel } from "./ui/labels.js";

/**
 * The User's own Runners: ways for Cronk to start their Agents' Runs with their own credentials.
 * A subscription Runner fires one claude.ai scheduled task per model label, optionally per Project.
 * Each card's count of running Runs and its pause stay current from the User's Runners stream, and a removed
 * Runner's card drops out of every open Runners page. A subscription Runner's card also says how to install the
 * Transcript hook, and makes its token for each Agent pointed at the Runner.
 */
export function RunnersScreen({ workspaces }: { workspaces: WorkspaceSummary[] }) {
  usePlace("runners");
  const [runners, setRunners] = useState<Runner[] | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [hook, setHook] = useState<TranscriptHook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useLatest();
  const refresh = useCallback(() => {
    latest(api.runners(), setRunners, (e) => setError(e.message));
  }, [latest]);
  useEffect(refresh, [refresh]);
  // A Run starting or ending on a Runner, or its queue pausing or resuming, changes its card; so may events missed while away.
  useRunnerEvents(refresh);
  useEffect(() => {
    Promise.all(workspaces.map((w) => api.projects(w.id))).then(
      (lists) => setProjects(lists.flat()),
      (e: Error) => setError(e.message),
    );
  }, [workspaces]);
  useEffect(() => {
    Promise.all(workspaces.map((w) => api.agents(w.id))).then(
      (lists) => setAgents(lists.flat()),
      (e: Error) => setError(e.message),
    );
  }, [workspaces]);
  useEffect(() => {
    api.transcriptHook().then(setHook, (e: Error) => setError(e.message));
  }, []);
  const replace = (updated: Runner) =>
    setRunners((all) => all?.map((r) => (r.id === updated.id ? updated : r)) ?? null);
  const drop = (removed: Runner) => setRunners((all) => all?.filter((r) => r.id !== removed.id) ?? null);

  const create = useSubmit(async (form, element) => {
    await api.createRunner({ name: field(form, "name"), kind: "subscription" });
    element.reset();
    refresh();
  });

  return (
    <div className="page page-settings">
      <PageHead crumbs={[{ label: "Yours" }]} title="Runners" switcher={<RunnersLiveIndicator />} />
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
        runners.map((runner) => (
          <RunnerSettings
            key={runner.id}
            runner={runner}
            projects={projects}
            workspaces={workspaces}
            agents={agents.filter((a) => a.runnerId === runner.id)}
            hook={hook}
            onChanged={replace}
            onRemoved={drop}
          />
        ))
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
  workspaces,
  agents: agentsOnIt,
  hook,
  onChanged,
  onRemoved,
}: {
  runner: Runner;
  projects: ProjectSummary[];
  workspaces: WorkspaceSummary[];
  /** The Agents pointed at it, as the page loaded them. */
  agents: Agent[];
  hook: TranscriptHook | null;
  onChanged: (runner: Runner) => void;
  onRemoved: (runner: Runner) => void;
}) {
  const [removingTrigger, setRemovingTrigger] = useState<Trigger | null>(null);
  const [settingUp, setSettingUp] = useState(false);
  const [removing, setRemoving] = useState(false);
  // The Agents pointed at it, loaded as removing it asks first, so the dialog names them as they stand.
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  useEffect(() => {
    if (!removing) return setAgents(null);
    let current = true;
    setAgentsError(null);
    Promise.all(workspaces.map((w) => api.agents(w.id))).then(
      (lists) => current && setAgents(lists.flat().filter((a) => a.runnerId === runner.id)),
      (e: Error) => current && setAgentsError(e.message),
    );
    return () => {
      current = false;
    };
  }, [removing, workspaces, runner.id]);
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
  const projectName = (id: string | null) =>
    id === null ? "All Projects" : (projects.find((p) => p.id === id)?.name ?? "A Project you no longer see");
  const pausedUntil = runner.pausedUntil ? new Date(runner.pausedUntil) : null;

  return (
    <section aria-label={runner.name} className="panel runner-card">
      <header className="runner-card-head">
        <h2>{runner.name}</h2>
        <Chip>
          <span className="mono">{runner.kind}</span>
        </Chip>
        <span className="runner-usage">
          <strong>{runner.running}</strong> of <strong>{runner.limit}</strong> <span className="muted">running</span>
        </span>
        <Menu label={`More for ${runner.name}`}>
          <MenuItem tone="danger" onSelect={() => setRemoving(true)}>
            Remove…
          </MenuItem>
        </Menu>
      </header>
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`Remove ${runner.name}?`}
        confirm="Remove"
        onConfirm={async () => {
          await api.removeRunner(runner.id);
          onRemoved(runner);
        }}
      >
        {agentsError ?? (agents === null ? "Finding the Agents that use it…" : agentsLeft(agents))}{" "}
        {triggersGoing(runner.triggers)}
      </ConfirmDialog>
      {pausedUntil && (
        <Banner tone="warn" label="Paused">
          <p role="status">
            Rate limited: its queue is paused until{" "}
            <time dateTime={pausedUntil.toISOString()} title={pausedUntil.toLocaleString()}>
              {dayShown(pausedUntil, new Date())} {clockTime(pausedUntil)}
            </time>
            . Tickets waiting for it start once it resumes.
          </p>
        </Banner>
      )}
      <form onSubmit={limit.onSubmit} className="form-row runner-limit">
        <Field label="Runs at once">
          <input name="limit" type="number" min={1} max={100} required defaultValue={runner.limit} />
        </Field>
        <Button type="submit" disabled={limit.busy}>
          Save limit
        </Button>
        <Saved shown={limitSaved} />
        <FormError error={limit.error} />
      </form>
      {runner.kind === "subscription" && (
        <div className="runner-triggers">
          <h3>Triggers</h3>
          {runner.triggers.length === 0 ? (
            <p className="muted small">
              No triggers yet: Runs on this Runner can't start until one is saved for their Step's model.
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Project</th>
                  <th>Trigger</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
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
                      <div className="runner-trigger-id">
                        <code>{trigger.triggerId}</code>
                        {trigger.waitingForToken && <Chip tone="warn">waiting for token</Chip>}
                      </div>
                    </td>
                    <td className="cell-actions">
                      <div>
                        <Button variant="ghost" size="small" onClick={() => setRemovingTrigger(trigger)}>
                          Remove
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {runner.triggers.some((t) => t.waitingForToken) && (
            <div role="group" aria-label="Waiting for tokens" className="runner-waiting">
              <p className="muted small">
                For each trigger waiting for its token, open its routine in claude.ai, generate an API token there and
                paste it here. Generating a new token revokes the routine's previous one, so do it once per routine.
              </p>
              {runner.triggers
                .filter((t) => t.waitingForToken)
                .map((trigger) => (
                  <TokenPaste
                    key={trigger.id}
                    runner={runner}
                    trigger={trigger}
                    project={projectName(trigger.projectId)}
                    onChanged={onChanged}
                  />
                ))}
            </div>
          )}
          <div className="runner-setup">
            <span className="muted small">
              Or have your own Claude Code create a Project's routines, one per model label its board uses.
            </span>
            <Button onClick={() => setSettingUp(true)}>Set up with Claude Code</Button>
          </div>
          <RunnerSetupDialog
            open={settingUp}
            onOpenChange={setSettingUp}
            runner={runner}
            projects={projects}
            agents={agentsOnIt}
          />
          <form onSubmit={save.onSubmit} aria-label="Save a trigger" className="runner-trigger-form">
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
          <ConfirmDialog
            open={removingTrigger !== null}
            onOpenChange={(open) => !open && setRemovingTrigger(null)}
            title={
              removingTrigger?.projectId
                ? `Remove the ${removingTrigger.model} trigger for ${projectName(removingTrigger.projectId)}?`
                : `Remove the ${removingTrigger?.model ?? ""} trigger?`
            }
            confirm="Remove"
            onConfirm={async () => {
              if (removingTrigger) onChanged(await api.removeTrigger(runner.id, removingTrigger.id));
            }}
          >
            Its token is gone for good: saving this model again takes the token from claude.ai. Runs needing it can't
            start until then.
          </ConfirmDialog>
        </div>
      )}
      {runner.kind === "subscription" && hook && <TranscriptHookSetup hook={hook} agents={agentsOnIt} />}
    </section>
  );
}

/**
 * How to install the Transcript hook for a subscription Runner's Runs: the snippet to commit, with this Cronk's
 * address in it, the setup steps, and a *Transcript hook* token for each Agent pointed at the Runner, shown once.
 */
function TranscriptHookSetup({ hook, agents }: { hook: TranscriptHook; agents: Agent[] }) {
  const snippet = JSON.stringify(hook.settings, null, 2);
  const host = new URL(hook.script).host;
  return (
    <div className="runner-hook" aria-label="Transcript hook" role="group">
      <h3>Transcript hook</h3>
      <p className="muted small">
        Runs upload their Transcripts through a Claude Code hook this Cronk serves. Its uploads also tell Cronk a Run is
        still working, so a long turn doesn't become lost.
      </p>
      <ol className="runner-hook-steps">
        <li>
          <div className="runner-hook-snippet">
            <span>
              Commit this as <code>.claude/settings.json</code> in each Repository the scheduled tasks work on, merging
              it into any hooks already there:
            </span>
            <pre aria-label="settings.json snippet">{snippet}</pre>
            <div>
              <CopyButton text={snippet} label="Copy snippet" />
            </div>
          </div>
        </li>
        <li>
          Make a Transcript hook token below for the Agent pointed at this Runner, and add it to the cloud environment
          of its scheduled tasks as the variable <code>{hook.tokenVariable}</code>.
        </li>
        <li>
          Give that environment <strong>Full</strong> network access, or add <code>{host}</code> to its{" "}
          <strong>Limited</strong> allowlist, so the hook can reach Cronk.
        </li>
        <li>
          Hooks only run in cloud sessions with one Repository: a scheduled task with several gets no Transcripts.
        </li>
      </ol>
      {agents.length === 0 ? (
        <p className="muted small">No Agent uses this Runner yet: point one at it from its page to make its token.</p>
      ) : (
        agents.map((agent) => <HookToken key={agent.id} agent={agent} variable={hook.tokenVariable} />)
      )}
    </div>
  );
}

/** Makes a *Transcript hook* token for an Agent, showing it once; it is revoked on its own on the Agent's page. */
function HookToken({ agent, variable }: { agent: Agent; variable: string }) {
  const [issued, setIssued] = useState<{ token: AgentToken; secret: string } | null>(null);
  const make = useSubmit(async () => {
    setIssued(await api.issueToken(agent.id, { name: "Transcript hook", access: "full" }));
  });
  return (
    <form onSubmit={make.onSubmit} className="runner-hook-token" aria-label={`Transcript hook token for ${agent.name}`}>
      <Actions>
        <Button type="submit" disabled={make.busy}>
          Make a Transcript hook token for {agent.name}
        </Button>
      </Actions>
      <FormError error={make.error} />
      {issued && (
        <ShownOnce banner="Token made" label={`${variable} for ${agent.name}`} secret={issued.secret}>
          It is listed among {agent.name}'s tokens as <em>Transcript hook</em>, where revoking it stops only the hook's
          uploads.
        </ShownOnce>
      )}
    </form>
  );
}

/** Pastes the token of a trigger waiting for it, beside a link to its routine in claude.ai. */
function TokenPaste({
  runner,
  trigger,
  project,
  onChanged,
}: {
  runner: Runner;
  trigger: Trigger;
  project: string;
  onChanged: (runner: Runner) => void;
}) {
  const paste = useSubmit(async (form) => {
    onChanged(await api.pasteTriggerToken(runner.id, trigger.id, field(form, "token")));
  });
  const name = `${trigger.model} on ${project}`;
  return (
    <form onSubmit={paste.onSubmit} aria-label={`Token for ${name}`} className="runner-token-paste">
      <div className="form-row">
        <Field label={`Token for ${name}`}>
          <input name="token" type="password" required autoComplete="off" />
        </Field>
        <Button type="submit" disabled={paste.busy}>
          Save token
        </Button>
        <a href={trigger.routineUrl} target="_blank" rel="noreferrer">
          Open routine in claude.ai
        </a>
      </div>
      <FormError error={paste.error} />
    </form>
  );
}

/**
 * Starts a Runner setup for a Project: the User picks the Project, and the Agent whose Transcript hook token it makes
 * when several are pointed at the Runner there, then copies the command into their own Claude Code.
 */
function RunnerSetupDialog({
  open,
  onOpenChange,
  runner,
  projects,
  agents,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runner: Runner;
  projects: ProjectSummary[];
  /** The Agents pointed at the Runner, in every Workspace. */
  agents: Agent[];
}) {
  const [projectId, setProjectId] = useState("");
  const [started, setStarted] = useState<StartedSetup | null>(null);
  useEffect(() => {
    if (!open) {
      setStarted(null);
      setProjectId("");
    }
  }, [open]);
  const project = projects.find((p) => p.id === projectId);
  const choices = project ? agents.filter((a) => a.workspaceId === project.workspaceId) : [];
  const start = useSubmit(async (form) => {
    const agentId = field(form, "agentId");
    setStarted(await api.startRunnerSetup(runner.id, { projectId: field(form, "projectId"), ...(agentId ? { agentId } : {}) }));
  });
  const expiresAt = started ? new Date(started.expiresAt) : null;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Set up with Claude Code"
      description={
        started
          ? undefined
          : `Your own Claude Code creates a claude.ai routine on ${runner.name} for each model label the Project's board uses, with only its Repository and the Cronk connector, and reports their trigger ids back.`
      }
      wide
    >
      {started && expiresAt ? (
        <div className="runner-setup-started">
          {started.warning && (
            <Banner tone="warn" label="Several Repositories">
              <p>{started.warning}</p>
            </Banner>
          )}
          <Field
            label="Command"
            hint={`Paste it into a terminal with Claude Code signed in to your claude.ai account. It works once, until ${clockTime(expiresAt)}.`}
          >
            <textarea readOnly rows={3} value={started.command} className="mono" onFocus={(event) => event.currentTarget.select()} />
          </Field>
          <div>
            <CopyButton text={started.command} label="Copy command" />
          </div>
          <table aria-label="Routines">
            <thead>
              <tr>
                <th>Model</th>
                <th>Model id</th>
                <th>Routine</th>
              </tr>
            </thead>
            <tbody>
              {started.plan.routines.map((routine) => (
                <tr key={routine.label}>
                  <td>
                    <ModelLabel model={routine.label} />
                  </td>
                  <td>
                    <code>{routine.modelId}</code>
                  </td>
                  <td>{routine.name}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">
            Claude Code asks which cloud environment to use, and shows you the Transcript hook token of{" "}
            {started.plan.agent.name} to add to it as <code>CRONK_TOKEN</code>. Once it reports back, the routines'
            triggers show on this card, each waiting for the token you generate in claude.ai.
          </p>
          <DialogActions>
            <DialogClose asChild>
              <Button variant="primary">Done</Button>
            </DialogClose>
          </DialogActions>
        </div>
      ) : (
        <form onSubmit={start.onSubmit} className="runner-setup-form">
          <Field label="Project">
            <select name="projectId" required value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              <option value="" disabled>
                Choose a Project
              </option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          {choices.length > 1 && (
            <Field label="Transcript hook token of" hint="The Agent whose token the routines' cloud environment uploads Transcripts with.">
              <select name="agentId" required defaultValue="">
                <option value="" disabled>
                  Choose an Agent
                </option>
                {choices.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <FormError error={start.error} />
          <DialogActions>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button type="submit" variant="primary" disabled={start.busy}>
              Make the command
            </Button>
          </DialogActions>
        </form>
      )}
    </Dialog>
  );
}

/** What removing a Runner does to the Agents pointed at it. */
function agentsLeft(agents: Agent[]): string {
  if (agents.length === 0) return "No Agent uses it.";
  const names = listed(agents.map((a) => a.name));
  return agents.length === 1
    ? `${names} is left with no Runner, so its Runs can't start until you choose another.`
    : `${names} are left with no Runner, so their Runs can't start until you choose others.`;
}

/** What removing a Runner does to its triggers. */
function triggersGoing(triggers: Trigger[]): string {
  if (triggers.length === 0) return "";
  const models = listed(triggers.map((t) => t.model));
  return triggers.length === 1 ? `Its ${models} trigger goes with it, token and all.` : `Its ${models} triggers go with it, tokens and all.`;
}

/** Names in a sentence: "a", "a and b", "a, b and c". */
function listed(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
