import type { ReactNode } from "react";
import type { DecisionStatus, Priority, RunState as RunStateName, StatusKind } from "../api.js";

/**
 * The small marks of docs/ui.md that tell kinds and states apart: Status dots and pills, Priority tags, chips,
 * Run states, kind labels and Decision statuses. Each says in words what its colour backs up.
 */

const kindNames: Record<StatusKind, string> = {
  backlog: "Backlog",
  active: "Active",
  review: "Review",
  done: "Done",
  canceled: "Canceled",
};

/** A Status kind's dot. Shown alone it carries the Status's name as its accessible name and tooltip. */
export function StatusDot({ kind, name, alone = false }: { kind: StatusKind; name?: string; alone?: boolean }) {
  const label = name ? `${name} (${kindNames[kind]})` : kindNames[kind];
  return alone ? (
    <span className={`status-dot status-dot-${kind}`} role="img" aria-label={label} title={label} />
  ) : (
    <span className={`status-dot status-dot-${kind}`} aria-hidden="true" />
  );
}

/** A Status: its kind's dot and its name, with its Step's model label when it has one. */
export function StatusPill({ kind, name, model }: { kind: StatusKind; name: string; model?: string | null }) {
  return (
    <span className="status-pill">
      <StatusDot kind={kind} />
      <span>{name}</span>
      {model && <span className="model-label">{model}</span>}
    </span>
  );
}

const priorityNames: Record<Priority, string> = { urgent: "Urgent", high: "High", medium: "Medium", low: "Low", none: "None" };

/** A Priority as a small uppercase tag; None shows nothing. */
export function PriorityTag({ priority }: { priority: Priority }) {
  if (priority === "none") return null;
  return (
    <span className={`priority priority-${priority}`} title={`Priority: ${priorityNames[priority]}`}>
      {priorityNames[priority]}
    </span>
  );
}

export type Tone = "neutral" | "ok" | "warn" | "info";

/** A Label, or with a tone, a state marker such as "Verified" or "Unverified". */
export function Chip({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`chip chip-${tone}`} title={title}>
      {children}
    </span>
  );
}

/** What a Run state or a wait reads as. */
const runStateWords: Record<RunStateName | "waiting", string> = {
  running: "running",
  finished: "finished",
  failed: "failed",
  lost: "lost",
  stopped: "stopped",
  refused: "couldn't start",
  waiting: "waiting",
};

/**
 * A Run's state as an 11px pill. Waiting (Runner full, rate-limited, blocked) gives its reason in the tooltip; the
 * reason and the word "Run" are also read out, so the pill makes sense on its own.
 */
export function RunState({ state, reason }: { state: RunStateName | "waiting"; reason?: string }) {
  return (
    <span className={`run-state run-state-${state}`} title={reason}>
      {state === "running" && <span className="pulse" aria-hidden="true" />}
      <span className="sr-only">Run </span>
      {runStateWords[state]}
      {reason && <span className="sr-only">: {reason}</span>}
    </span>
  );
}

/** The tone each kind of timeline entry or Inbox item is coloured with. */
const kindTones: Record<string, string> = {
  comment: "accent",
  question: "warn",
  "needs you": "warn",
  discovered: "warn",
  "sent back": "warn",
  reassign: "warn",
  failed: "danger",
  lost: "danger",
  error: "danger",
  "couldn't start": "warn",
  report: "agent",
  run: "agent",
  transcript: "agent",
  decision: "agent",
  "to review": "info",
  unverified: "info",
};

/** An 11px uppercase label naming what kind of thing an entry is; colour only backs it up. */
export function KindLabel({ kind }: { kind: string }) {
  const tone = kindTones[kind.toLowerCase()] ?? "muted";
  // Written as a word and shown in capitals, so it reads as a word.
  return <span className={`kind-label kind-${tone}`}>{kind[0]!.toUpperCase() + kind.slice(1)}</span>;
}

export const decisionStatusLabel = (status: DecisionStatus) => status[0]!.toUpperCase() + status.slice(1);

/** A Decision's status as an 11px pill. */
export function DecisionStatusPill({ status }: { status: DecisionStatus }) {
  return <span className={`decision-status decision-status-${status}`}>{decisionStatusLabel(status)}</span>;
}

/** A model label, in the mono face. */
export function ModelLabel({ model }: { model: string }) {
  return <span className="model-label">{model}</span>;
}

/** A Ticket or Project key, such as CRONK-12, in the mono face at 12px muted. */
export function Key({ children }: { children: ReactNode }) {
  return <span className="ticket-key">{children}</span>;
}

const pullRequestStates = { draft: "Draft", open: "Open", merged: "Merged", closed: "Closed" } as const;

/** A Pull Request's state as an 11px pill: Draft dashed muted, Open outlined ok, Merged agent-soft, Closed outlined danger. */
export function PullRequestState({ state }: { state: keyof typeof pullRequestStates }) {
  return <span className={`pr-state pr-state-${state}`}>{pullRequestStates[state]}</span>;
}
