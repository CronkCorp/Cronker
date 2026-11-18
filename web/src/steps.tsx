import { useEffect, useState, type FormEvent } from "react";
import { api, type Brief, type Outcome, type Project, type Status, type Step } from "./api.js";
import { field, useSubmit } from "./forms.js";

/** A new Step's starting point: sends Tickets on to the next Status, or back to the first one for a person. */
function newStep(project: Project, status: Status): Step {
  const at = project.statuses.findIndex((s) => s.id === status.id);
  const next = project.statuses[at + 1] ?? project.statuses[0]!;
  return {
    brief: "",
    model: "sonnet",
    roundLimit: 2,
    outcomes: [
      { name: "done", statusId: next.id, default: true, needsYou: false, countsAsRound: false },
      { name: "needs you", statusId: project.statuses[0]!.id, default: false, needsYou: true, countsAsRound: false },
    ],
  };
}

/** Each Status's Step, to attach, edit or remove. Cronk checks the Outcomes; its refusals show here. */
export function StepsSettings({ project, onChange }: { project: Project; onChange: (project: Project) => void }) {
  return (
    <section aria-labelledby="steps-heading" className="settings">
      <h2 id="steps-heading">Steps</h2>
      <p className="muted">
        A delegated Ticket entering a Status with a Step gets a Run, which ends by choosing one of the Step's Outcomes.
        Tickets in a Status without a Step wait for a person.
      </p>
      <ul className="steps">
        {project.statuses.map((status) => (
          <StepItem key={status.id} project={project} status={status} onChange={onChange} />
        ))}
      </ul>
    </section>
  );
}

function StepItem({
  project,
  status,
  onChange,
}: {
  project: Project;
  status: Status;
  onChange: (project: Project) => void;
}) {
  const [draft, setDraft] = useState<Step | null>(status.step);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Show the Step as Cronk has it whenever it changes there, here or elsewhere.
  useEffect(() => setDraft(status.step), [status.step]);

  const run = async (change: () => Promise<Project>) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await change());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const summary = status.step
    ? `${status.step.model}, ${status.step.outcomes.length} Outcomes`
    : "No Step: Tickets here wait for a person";

  return (
    <li>
      <details open={draft !== null && status.step === null}>
        <summary>
          <strong>{status.name}</strong> <span className="muted">{summary}</span>
        </summary>
        {error && <p role="alert">{error}</p>}
        {draft === null ? (
          <button type="button" onClick={() => setDraft(newStep(project, status))}>
            Add a Step to {status.name}
          </button>
        ) : (
          <StepForm
            project={project}
            status={status}
            draft={draft}
            busy={busy}
            onDraft={setDraft}
            onSave={() => run(() => api.putStep(project.id, status.id, draft))}
            onCancel={() => setDraft(status.step)}
            onRemove={() => run(() => api.removeStep(project.id, status.id))}
          />
        )}
      </details>
    </li>
  );
}

function StepForm({
  project,
  status,
  draft,
  busy,
  onDraft,
  onSave,
  onCancel,
  onRemove,
}: {
  project: Project;
  status: Status;
  draft: Step;
  busy: boolean;
  onDraft: (step: Step) => void;
  onSave: () => Promise<void>;
  onCancel: () => void;
  onRemove: () => Promise<void>;
}) {
  const of = status.name;
  const setOutcome = (index: number, change: Partial<Outcome>) => {
    const outcomes = draft.outcomes.map((outcome, i) => {
      // Only one Outcome is the default, and only one is needs you.
      const cleared = {
        ...(change.default ? { default: false } : {}),
        ...(change.needsYou ? { needsYou: false } : {}),
      };
      return i === index ? { ...outcome, ...change } : { ...outcome, ...cleared };
    });
    onDraft({ ...draft, outcomes });
  };

  return (
    <form
      className="step"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void onSave();
      }}
    >
      <label>
        Brief for {of}
        <textarea
          rows={8}
          required
          maxLength={50_000}
          value={draft.brief}
          onChange={(e) => onDraft({ ...draft, brief: e.target.value })}
        />
      </label>
      <div className="inline">
        <label>
          Model for {of}
          <input
            required
            maxLength={50}
            pattern="\S+"
            value={draft.model}
            onChange={(e) => onDraft({ ...draft, model: e.target.value })}
          />
        </label>
        <label>
          Round limit for {of}
          <input
            type="number"
            min={0}
            max={100}
            required
            value={draft.roundLimit}
            onChange={(e) => onDraft({ ...draft, roundLimit: Number(e.target.value) })}
          />
        </label>
      </div>
      <fieldset>
        <legend>Outcomes of {of}</legend>
        <ol className="outcomes">
          {draft.outcomes.map((outcome, index) => {
            const label = outcome.name || `Outcome ${index + 1}`;
            return (
              <li key={index} className="inline">
                <input
                  aria-label={`Name of Outcome ${index + 1} of ${of}`}
                  required
                  maxLength={50}
                  value={outcome.name}
                  onChange={(e) => setOutcome(index, { name: e.target.value })}
                />
                <span aria-hidden="true">→</span>
                <select
                  aria-label={`Status ${label} of ${of} moves to`}
                  value={outcome.statusId}
                  onChange={(e) => setOutcome(index, { statusId: e.target.value })}
                >
                  {project.statuses.map((target) => (
                    <option key={target.id} value={target.id}>
                      {target.name}
                    </option>
                  ))}
                </select>
                <label className="check">
                  <input
                    type="radio"
                    name={`default-${status.id}`}
                    checked={outcome.default}
                    onChange={() => setOutcome(index, { default: true })}
                  />
                  Default
                </label>
                <label className="check">
                  <input
                    type="radio"
                    name={`needs-you-${status.id}`}
                    checked={outcome.needsYou}
                    onChange={() => setOutcome(index, { needsYou: true })}
                  />
                  Needs you
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={outcome.countsAsRound}
                    onChange={(e) => setOutcome(index, { countsAsRound: e.target.checked })}
                  />
                  Counts as a round
                </label>
                <button
                  type="button"
                  aria-label={`Remove Outcome ${label} of ${of}`}
                  onClick={() => onDraft({ ...draft, outcomes: draft.outcomes.filter((_, i) => i !== index) })}
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ol>
        <button
          type="button"
          onClick={() =>
            onDraft({
              ...draft,
              outcomes: [
                ...draft.outcomes,
                { name: "", statusId: status.id, default: false, needsYou: false, countsAsRound: false },
              ],
            })
          }
        >
          Add an Outcome to {of}
        </button>
      </fieldset>
      <div className="inline">
        <button type="submit" disabled={busy}>
          Save the Step on {of}
        </button>
        {status.step ? (
          <button type="button" disabled={busy} onClick={() => void onRemove()}>
            Remove the Step from {of}
          </button>
        ) : (
          <button type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

/** The full Brief a Run on a Ticket would receive in the Ticket's Status now. */
export function BriefPreview({ project }: { project: Project }) {
  const [brief, setBrief] = useState<Brief | null>(null);
  const { error, busy, onSubmit } = useSubmit(async (form) => {
    setBrief(null);
    const ticket = await api.ticketByKey(project.workspaceId, field(form, "key").trim());
    setBrief(await api.brief(ticket.id));
  });

  return (
    <section aria-labelledby="brief-heading" className="settings">
      <h2 id="brief-heading">Brief preview</h2>
      <p className="muted">
        What a Run on a Ticket would receive in the Ticket's Status: Cronk's preamble, the Step's Brief, then the
        Ticket's key.
      </p>
      <form className="inline" onSubmit={onSubmit}>
        <label>
          Ticket key
          <input name="key" required placeholder={`${project.key}-1`} />
        </label>
        <button type="submit" disabled={busy}>
          Preview Brief
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {brief && (
        <div className="brief" aria-label={`Brief for ${brief.ticketKey}`}>
          <h3>Cronk's preamble</h3>
          <pre>{brief.preamble}</pre>
          <h3>The Step's Brief</h3>
          <pre>{brief.brief}</pre>
          <h3>The Ticket key</h3>
          <pre>{brief.ticketKey}</pre>
        </div>
      )}
    </section>
  );
}
