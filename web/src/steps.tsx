import { useEffect, useState, type FormEvent } from "react";
import {
  api,
  labelRuleShown,
  type Brief,
  type LabelRule,
  type Outcome,
  type Project,
  type Status,
  type Step,
  type StepKind,
} from "./api.js";
import { field, useSave, useSubmit } from "./forms.js";
import { Actions, Button, Check, Field, FormError, Panel, Saved } from "./ui/controls.js";
import { StatusPill } from "./ui/labels.js";

/**
 * A new Step's starting point: sends Tickets on to the next Status, or back to the first other one for a User,
 * since *needs you* may not leave a Ticket on its Step's own Status.
 */
function newStep(project: Project, status: Status): Step {
  const at = project.statuses.findIndex((s) => s.id === status.id);
  const next = project.statuses[at + 1] ?? project.statuses[0]!;
  const firstOther = project.statuses.find((s) => s.id !== status.id)!;
  return {
    kind: "ordinary",
    brief: "",
    model: "sonnet",
    roundLimit: 2,
    labelRule: null,
    outcomes: [
      { name: "done", statusId: next.id, default: true, needsYou: false, countsAsRound: false },
      { name: "needs you", statusId: firstOther.id, default: false, needsYou: true, countsAsRound: false },
    ],
  };
}

/** Each Status's Step, to attach, edit or remove. Cronk checks the Outcomes; its refusals show here. */
export function StepsSettings({ project, onChange }: { project: Project; onChange: (project: Project) => void }) {
  return (
    <Panel
      title="Steps"
      id="steps"
      description="A delegated Ticket entering a Status with a Step gets a Run, which ends by choosing one of the Step's Outcomes. One its Label rule doesn't let through gets no Run and moves on by the default Outcome, as does one a Merge Step skips: every Ticket without Autonomous Delegation, and all of them while agents may not merge. Tickets in a Status without a Step wait for a User."
    >
      <ul className="steps">
        {project.statuses.map((status) => (
          <StepItem key={status.id} project={project} status={status} onChange={onChange} />
        ))}
      </ul>
    </Panel>
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
  const [open, setOpen] = useState(false);
  const { error, busy, saved, save, clear } = useSave();
  // Show the Step as Cronk has it whenever it changes there, here or elsewhere. Compared by
  // value: reloading the Project for a change elsewhere mustn't throw away an unsaved draft.
  const kept = JSON.stringify(status.step);
  useEffect(() => setDraft(JSON.parse(kept) as Step | null), [kept]);

  const run = (change: () => Promise<Project>) => save(async () => onChange(await change()));

  const summary = status.step
    ? [
        ...(status.step.kind === "merge" ? ["Merge Step"] : []),
        status.step.model,
        `${status.step.outcomes.length} Outcomes`,
        ...(status.step.labelRule ? [labelRuleShown(status.step.labelRule)] : []),
      ].join(", ")
    : "No Step: Tickets here wait for a User";

  return (
    <li>
      {/* Opened by the User, it stays open after saving, so "Saved." shows beside the buttons. */}
      <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          <StatusPill kind={status.kind} name={status.name} /> <span className="muted small">{summary}</span>
        </summary>
        <FormError error={error} />
        {draft === null ? (
          <Actions>
            <Button onClick={() => setDraft(newStep(project, status))}>Add a Step to {status.name}</Button>
            <Saved shown={saved} />
          </Actions>
        ) : (
          <StepForm
            project={project}
            status={status}
            draft={draft}
            busy={busy}
            saved={saved}
            onDraft={setDraft}
            onSave={() => run(() => api.putStep(project.id, status.id, draft))}
            onCancel={() => {
              // A refusal of the draft goes with it.
              setDraft(status.step);
              clear();
            }}
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
  saved,
  onDraft,
  onSave,
  onCancel,
  onRemove,
}: {
  project: Project;
  status: Status;
  draft: Step;
  busy: boolean;
  saved: boolean;
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
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void onSave();
      }}
    >
      <Field label={`Brief for ${of}`}>
        <textarea
          className="markdown-source"
          rows={8}
          required
          maxLength={50_000}
          value={draft.brief}
          onChange={(e) => onDraft({ ...draft, brief: e.target.value })}
        />
      </Field>
      <div className="form-row">
        <Field label={`Kind of Step for ${of}`}>
          <select value={draft.kind} onChange={(e) => onDraft({ ...draft, kind: e.target.value as StepKind })}>
            <option value="ordinary">Ordinary: every Ticket its Label rule lets through gets a Run</option>
            <option value="merge">Merge: skipped unless an agent may merge the Ticket</option>
          </select>
        </Field>
        <Field label={`Model for ${of}`}>
          <input
            className="mono"
            required
            maxLength={50}
            pattern="\S+"
            value={draft.model}
            onChange={(e) => onDraft({ ...draft, model: e.target.value })}
          />
        </Field>
        <Field label={`Round limit for ${of}`}>
          <input
            type="number"
            min={0}
            max={100}
            required
            value={draft.roundLimit}
            onChange={(e) => onDraft({ ...draft, roundLimit: Number(e.target.value) })}
          />
        </Field>
      </div>
      <div className="form-row">
        <Field label={`Label rule for ${of}`}>
          <select
            value={draft.labelRule?.kind ?? ""}
            onChange={(e) => {
              const kind = e.target.value as LabelRule["kind"] | "";
              onDraft({ ...draft, labelRule: kind ? { kind, label: draft.labelRule?.label ?? "" } : null });
            }}
          >
            <option value="">None: every Ticket gets a Run</option>
            <option value="requires">Requires a Label</option>
            <option value="skippedBy">Skipped by a Label</option>
          </select>
        </Field>
        {draft.labelRule && (
          <Field label={`Label for the rule of ${of}`}>
            <input
              required
              maxLength={50}
              pattern=".*\S.*"
              value={draft.labelRule.label}
              onChange={(e) => onDraft({ ...draft, labelRule: { ...draft.labelRule!, label: e.target.value } })}
            />
          </Field>
        )}
      </div>
      <fieldset>
        <legend className="field-label">Outcomes of {of}</legend>
        <ol className="outcomes">
          {draft.outcomes.map((outcome, index) => {
            const label = outcome.name || `Outcome ${index + 1}`;
            return (
              <li key={index} className="outcome">
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
                <Check
                  type="radio"
                  label="Default"
                  name={`default-${status.id}`}
                  checked={outcome.default}
                  onChange={() => setOutcome(index, { default: true })}
                />
                <Check
                  type="radio"
                  label="Needs you"
                  name={`needs-you-${status.id}`}
                  checked={outcome.needsYou}
                  onChange={() => setOutcome(index, { needsYou: true })}
                />
                <Check label="Counts as a round" checked={outcome.countsAsRound} onChange={(e) => setOutcome(index, { countsAsRound: e.target.checked })} />
                <Button
                  variant="ghost"
                  size="small"
                  aria-label={`Remove Outcome ${label} of ${of}`}
                  onClick={() => onDraft({ ...draft, outcomes: draft.outcomes.filter((_, i) => i !== index) })}
                >
                  Remove
                </Button>
              </li>
            );
          })}
        </ol>
        <div>
        <Button
          size="small"
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
        </Button>
        </div>
      </fieldset>
      <Actions>
        <Button type="submit" variant="primary" disabled={busy}>
          Save the Step on {of}
        </Button>
        {status.step ? (
          <Button variant="ghost" disabled={busy} onClick={() => void onRemove()}>
            Remove the Step from {of}
          </Button>
        ) : (
          <Button variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Saved shown={saved} />
      </Actions>
    </form>
  );
}

/** The full Brief a Run on a Ticket would receive in the Ticket's Status now. */
export function BriefPreview({ project }: { project: Project }) {
  const [brief, setBrief] = useState<Brief | null>(null);
  const { error, busy, onSubmit } = useSubmit(async (form) => {
    setBrief(null);
    const key = field(form, "key").trim();
    const ticket = await api.ticketByKey(project.workspaceId, key);
    if (ticket.projectId !== project.id) throw new Error(`${ticket.key} is a Ticket of another Project.`);
    setBrief(await api.brief(ticket.id));
  });

  return (
    <Panel
      title="Brief preview"
      id="brief"
      description="What a Run on a Ticket would receive in the Ticket's Status: Cronk's preamble, the Step's Brief, then the Ticket's key."
    >
      <form onSubmit={onSubmit}>
        <Field label="Ticket key">
          <input name="key" required placeholder={`${project.key}-1`} className="mono" />
        </Field>
        <Actions>
          <Button type="submit" disabled={busy}>
            Preview Brief
          </Button>
        </Actions>
      </form>
      <FormError error={error} />
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
    </Panel>
  );
}
