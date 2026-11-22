import type { Context } from "../context.js";
import { requireSecretBox } from "../encryption.js";
import type { Runner, RunnerRefusal, RunToStart, StartResult } from "./runner.js";

/**
 * The subscription Runner: Claude Code on the web scheduled tasks, fired by API, spending the Owner's
 * own Claude subscription. The model, Repository and connectors are fixed on each task in claude.ai,
 * so the Owner gives Cronk one trigger per model label, optionally overridden per Project; starting a
 * Run fires the trigger for the Step's model with the Brief as the fire's `text`. The Brief carries no
 * secret: the session reaches Cronk through its own claude.ai connector.
 *
 * It reports no ends: a Run whose claude.ai session ends without calling `finish` becomes lost.
 */

/** The beta the fire endpoint ships under; breaking changes come under a newer dated one. */
const fireBeta = "experimental-cc-routine-2026-04-01";
/** How long a 429 without a usable `Retry-After` pauses the Runner's queue. */
const defaultRetryAfterMs = 60_000;
/** The longest a 429 pauses the Runner's queue, whatever its `Retry-After` says. */
const longestRetryAfterMs = 24 * 60 * 60 * 1000;
/** An HTTP date, such as `Thu, 01 Jan 2026 10:00:00 GMT` (RFC 9110's preferred form). */
const httpDate = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/** A sealed trigger as stored. */
interface StoredTrigger {
  triggerId: string;
  /** None while the trigger, saved without it or made by a Runner setup, waits for the token its Owner pastes. */
  tokenSealed: string | null;
}

/** The trigger for the model on the Project's Tickets: the Project's own, else the Runner's. */
async function triggerFor({ db }: Context, run: RunToStart): Promise<StoredTrigger | undefined> {
  const { rows } = await db.query<StoredTrigger>(
    `select trigger_id as "triggerId", token_sealed as "tokenSealed" from runner_triggers
     where runner_id = $1 and lower(model) = lower($2) and (project_id = $3 or project_id is null)
     order by project_id nulls last limit 1`,
    [run.runner.id, run.model, run.project.id],
  );
  return rows[0];
}

/**
 * When to try again after a 429, from its `Retry-After`: seconds or an HTTP date, a minute when it is
 * neither, and a day at most.
 */
export function retryAt(now: Date, retryAfter: string | null): Date {
  const value = retryAfter?.trim() ?? "";
  let waitMs = defaultRetryAfterMs;
  if (/^\d+$/.test(value)) waitMs = Number(value) * 1000;
  else if (httpDate.test(value)) waitMs = Math.max(0, Date.parse(value) - now.getTime());
  return new Date(now.getTime() + Math.min(waitMs, longestRetryAfterMs));
}

export function subscriptionRunner(context: Context): Runner {
  return {
    // A claude.ai routine runs in a cloud session.
    cloud: true,
    async start(run): Promise<StartResult> {
      const refuse = (refusal: RunnerRefusal): StartResult => ({ started: false, refusal });
      const trigger = await triggerFor(context, run);
      if (!trigger) {
        return refuse({
          kind: "not_configured",
          message:
            `${run.runner.name} has no trigger for the model ${run.model}: its Owner adds one in the Runner's ` +
            `settings, for all Projects or for ${run.project.name}.`,
        });
      }
      const named = `the trigger ${trigger.triggerId} for ${run.model} on ${run.runner.name}`;
      if (trigger.tokenSealed === null) {
        return refuse({
          kind: "not_configured",
          message:
            `${run.runner.name}'s trigger ${trigger.triggerId} for ${run.model} on ${run.project.name} is waiting for its ` +
            "token: its Owner generates one for the routine in claude.ai and pastes it into the trigger on the Runner's card.",
        });
      }
      let token: string;
      try {
        token = requireSecretBox(context.config).open(trigger.tokenSealed);
      } catch {
        return refuse({
          kind: "not_configured",
          message:
            `Cronk can't read the token of ${named}, as CRONK_SECRET_KEY changed or is unset: ` +
            "its Owner saves the trigger again.",
        });
      }

      const url = new URL(
        `v1/claude_code/routines/${encodeURIComponent(trigger.triggerId)}/fire`,
        context.config.claudeApiUrl,
      );
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "anthropic-beta": fireBeta,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({ text: run.brief }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        return refuse({
          kind: "unavailable",
          message: `Cronk couldn't reach claude.ai to fire ${named}: ${(error as Error).message}.`,
        });
      }
      if (response.status === 429) {
        const until = retryAt(context.clock.now(), response.headers.get("retry-after"));
        return refuse({ kind: "rate_limited", message: `claude.ai rate limited ${named}.`, retryAt: until });
      }
      if (response.status === 401 || response.status === 403) {
        return refuse({
          kind: "credentials_rejected",
          message: `claude.ai rejected the token of ${named}: its Owner generates a new token in claude.ai and saves it here.`,
        });
      }
      if (response.status === 404) {
        return refuse({
          kind: "not_configured",
          message: `claude.ai has no scheduled task for ${named}: its Owner checks the trigger id, or saves a new trigger.`,
        });
      }
      if (!response.ok) {
        return refuse({ kind: "unavailable", message: `claude.ai answered ${response.status} when firing ${named}.` });
      }
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const textOrNone = (value: unknown) => (typeof value === "string" ? value : undefined);
      return {
        started: true,
        reference: { sessionId: textOrNone(body.claude_code_session_id), url: textOrNone(body.claude_code_session_url) },
      };
    },
  };
}
