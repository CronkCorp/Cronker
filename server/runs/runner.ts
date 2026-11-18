/**
 * The Runner interface: the one narrow seam between Cronk and whatever runs agents (ADR 0001).
 * Cronk asks a Runner to start a Run with its Brief and model; a Runner that can see a Run end
 * without finishing reports it back. Everything specific to one way of running agents stays
 * behind this seam.
 */

/** What a Runner needs to start a Run. */
export interface RunToStart {
  runId: string;
  /** The full Brief, as the Run receives it. */
  brief: string;
  /** The label of the model the Step wants, such as `haiku`. */
  model: string;
  ticket: { id: string; key: string };
  project: { id: string; key: string; name: string };
  /** The Agent the Run acts as. */
  agent: { id: string; name: string };
  /** The Runner record, set up by the Agent's Owner, the Run starts through. */
  runner: { id: string; ownerId: string; name: string };
}

/** Where a started Run can be followed, such as its claude.ai session. */
export interface RunReference {
  sessionId?: string;
  url?: string;
}

/** Why a Runner didn't start a Run. */
export type RunnerRefusal =
  | { kind: "not_configured"; message: string }
  | { kind: "credentials_rejected"; message: string }
  | { kind: "rate_limited"; message: string; retryAt: Date }
  | { kind: "unavailable"; message: string };

/** What a Runner needs to stop a Run it started. */
export interface RunToStop {
  runId: string;
  reference: RunReference;
}

export type StartResult = { started: true; reference: RunReference } | { started: false; refusal: RunnerRefusal };

/** What a Runner tells Cronk about its Runs after starting them. */
export interface RunReports {
  /** The Run's session ended without the agent calling `finish`: the Run becomes failed. */
  endedWithoutFinishing(runId: string, reason: string): Promise<void>;
}

export interface Runner {
  start(run: RunToStart): Promise<StartResult>;
  /** Best effort; a Runner that can't stop its sessions leaves this out. */
  stop?(run: RunToStop): Promise<void>;
}

/** Builds a kind of Runner, given where to report its Runs' ends. */
export type RunnerKind = (reports: RunReports) => Runner;
