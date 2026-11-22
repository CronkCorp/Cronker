import type { Cost } from "./costs.js";

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
  /**
   * The Repositories the Project lists, by GitHub's id and `owner/name`. A Runner that mounts them, such as the
   * Managed Agents Runner, asks the GitHub App for their installation tokens itself.
   */
  repositories: { id: number; fullName: string }[];
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
  /** What the Run's session cost, once the Run ended; a later report replaces an earlier one. */
  cost(runId: string, cost: Cost): Promise<void>;
}

export interface Runner {
  /**
   * Whether its Runs run in the cloud, such as claude.ai or Anthropic's sessions, rather than on a machine of its
   * Owner's: a Ticket labelled `local-only` gets no Run through a cloud Runner. Every kind says which it is.
   */
  cloud: boolean;
  start(run: RunToStart): Promise<StartResult>;
  /**
   * Cronk ended the Run itself (a User took its Ticket away, or it was lost) and asks the Runner to stop its session.
   * Best effort; a Runner that can't stop its sessions leaves this out.
   */
  stop?(run: RunToStop): Promise<void>;
  /**
   * A Run Cronk didn't stop itself ended: its Agent finished it (or merged), or the Runner reported it ended without
   * finishing. The Runner lets go of what the Run held, such as its session and credentials. Best effort.
   */
  ended?(run: RunToStop): Promise<void>;
  /**
   * Someone opens the Transcript of the running Run: the Runner adds to it what the Run's session did since it last
   * looked, where Cronk fetches Transcripts itself rather than having them uploaded. Throws when it can't.
   */
  followTranscript?(run: { runId: string }): Promise<void>;
  /** Removing a Runner of this kind stops its running Runs, instead of being refused while they run. */
  stopsRunsWhenRemoved?: boolean;
}

/** Builds a kind of Runner, given where to report its Runs' ends. */
export type RunnerKind = (reports: RunReports) => Runner;

/** The Label marking a Ticket as work that can't run in a cloud session, matched ignoring case. */
export const LOCAL_ONLY_LABEL = "local-only";

/** Whether the Labels mark their Ticket as `local-only`. */
export const isLocalOnly = (labels: readonly string[]): boolean => labels.some((label) => label.toLowerCase() === LOCAL_ONLY_LABEL);

/** Whether a Runner of the kind, among this Cronk's, runs in the cloud; no Runner, or a kind this Cronk lacks, doesn't. */
export const runsInCloud = (runners: Record<string, Runner>, kind: string | null | undefined): boolean =>
  kind != null && Object.hasOwn(runners, kind) && runners[kind]!.cloud;
