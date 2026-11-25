import type { Context } from "../context.js";
import { ApiError } from "../http/errors.js";
import { retryAt } from "../runs/subscription.js";
import { GitHubUnavailable } from "./client.js";

/**
 * Whether GitHub's API is available to Cronk: the status check the calls that would otherwise hammer it consult, such
 * as the Merge Queue's merges and mergeability checks. A call that meets an outage (`GitHubUnavailable`: no answer, a
 * server error or GitHub's rate limit) marks GitHub unavailable until a time: when its rate limit lifts, where it says,
 * otherwise after a backoff that doubles with each outage in a row, from 30 seconds to 10 minutes. Until then, calls
 * through `throughGitHub` are refused without reaching GitHub; the first after it goes out, and its success marks
 * GitHub available again. It is held in memory: a restart forgets it, and the next call finds an outage again.
 */

/** How long Cronk waits after a first outage with no time GitHub gives. */
const firstBackoffMs = 30_000;

/** The longest Cronk waits between asks while GitHub stays unavailable. */
const longestBackoffMs = 10 * 60 * 1000;

/** The longest wait for GitHub's rate limit to lift, as for `Retry-After`: a day. */
const longestPauseMs = 24 * 60 * 60 * 1000;

/**
 * When GitHub's rate limit lifts: its `Retry-After` when it gives one, else its `X-RateLimit-Reset` (seconds since the
 * epoch), else a minute from now; never in the past, and a day at most.
 */
export function limitLifts(now: Date, limit: { retryAfter: string | null; reset: string | null }): Date {
  const reset = limit.reset?.trim() ?? "";
  if (limit.retryAfter !== null || !/^\d+$/.test(reset)) return retryAt(now, limit.retryAfter);
  return new Date(Math.min(Math.max(Number(reset) * 1000, now.getTime()), now.getTime() + longestPauseMs));
}

/** GitHub marked unavailable: until when, and what the call that found it so met. */
export interface GitHubOutage {
  until: Date;
  reason: string;
}

/** A change of GitHub's availability, said once as it happens, not on each call refused meanwhile. */
export type GitHubStatusChange = ({ kind: "unavailable" } & GitHubOutage) | { kind: "recovered" };

export class GitHubStatus {
  #outage: GitHubOutage | null = null;
  /** Outages in a row since GitHub last answered. */
  #outages = 0;
  /** Told of each change, as a log. */
  onChange: (change: GitHubStatusChange) => void = () => {};

  /** The outage Cronk is waiting out at `now`, if any. */
  waitingUntil(now: Date): GitHubOutage | null {
    return this.#outage && this.#outage.until > now ? this.#outage : null;
  }

  /** A call met an outage at `now`. */
  failed(error: GitHubUnavailable, now: Date): void {
    this.#outages++;
    const backoff = Math.min(firstBackoffMs * 2 ** (this.#outages - 1), longestBackoffMs);
    const until = error.limit ? limitLifts(now, error.limit) : new Date(now.getTime() + backoff);
    const known = this.#outage !== null;
    this.#outage = { until, reason: error.message };
    if (!known) this.onChange({ kind: "unavailable", ...this.#outage });
  }

  /** GitHub answered a call. */
  succeeded(): void {
    const known = this.#outage !== null;
    this.#outage = null;
    this.#outages = 0;
    if (known) this.onChange({ kind: "recovered" });
  }
}

/** Refused without asking GitHub, as Cronk waits out an outage. */
export class WaitingForGitHub extends ApiError {
  constructor(readonly outage: GitHubOutage) {
    super(
      503,
      "github_unavailable",
      `GitHub is unavailable (${outage.reason}), so Cronk won't ask it again before ${outage.until.toISOString()}.`,
      {
        rule: "Cronk doesn't ask GitHub again while it waits out an outage or GitHub's rate limit.",
        advice: `Wait until ${outage.until.toISOString()}, then try again.`,
      },
      { retryAt: outage.until.toISOString() },
    );
  }
}

/** Whether the error is GitHub being unavailable: an outage a call met, or Cronk waiting one out. */
export const isGitHubOutage = (error: unknown): boolean =>
  error instanceof WaitingForGitHub || (error instanceof GitHubUnavailable && error.outage);

/**
 * Runs `ask`, which calls GitHub, unless Cronk is waiting out an outage, refusing with `WaitingForGitHub` then. An
 * outage `ask` meets marks GitHub unavailable; an answer, or GitHub's refusal that is no outage, marks it available.
 * Cronk's own refusals in `ask`, which may come before GitHub is asked, leave it as it is.
 */
export async function throughGitHub<T>(context: Context, ask: () => Promise<T>): Promise<T> {
  const waiting = context.githubStatus.waitingUntil(context.clock.now());
  if (waiting) throw new WaitingForGitHub(waiting);
  try {
    const answer = await ask();
    context.githubStatus.succeeded();
    return answer;
  } catch (error) {
    if (error instanceof GitHubUnavailable) {
      if (error.outage) context.githubStatus.failed(error, context.clock.now());
      else context.githubStatus.succeeded();
    }
    throw error;
  }
}
