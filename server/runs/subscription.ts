import type { Context } from "../context.js";
import { secretBox } from "../encryption.js";
import type { Runner, RunnerRefusal, RunToStart, StartResult } from "./runner.js";

/**
 * The subscription Runner: Claude Code on the web scheduled tasks, fired by API, spending the Owner's
 * own Claude subscription. The model, Repository and connectors are fixed on each task in claude.ai,
 * so the Owner gives Cronk one trigger per model label, optionally overridden per Project; starting a
 * Run fires the trigger for the Step's model with the Brief as the fire's `text`. The Brief carries no
 * secret: the session reaches Cronk through its own claude.ai connector.
 *
 * It reports no ends: lost-Run detection covers sessions that end without calling `finish`.
 */

/** The beta the fire endpoint ships under; breaking changes come under a newer dated one. */
const fireBeta = "experimental-cc-routine-2026-04-01";
/** How long a 429 without a usable `Retry-After` pauses the Runner's queue. */
const defaultRetryAfterMs = 60_000;

/** The trigger for the model on the Project's Tickets: the Project's own, else the Runner's. */
async function triggerFor(
  { db }: Context,
  run: RunToStart,
): Promise<{ triggerId: string; tokenSealed: string } | undefined> {
  const { rows } = await db.query<{ triggerId: string; tokenSealed: string }>(
    `select trigger_id as "triggerId", token_sealed as "tokenSealed" from runner_triggers
     where runner_id = $1 and lower(model) = lower($2) and (project_id = $3 or project_id is null)
     order by project_id nulls last limit 1`,
    [run.runner.id, run.model, run.project.id],
  );
  return rows[0];
}

/** When to try again after a 429, from its `Retry-After`: seconds or an HTTP date. */
function retryAt(now: Date, retryAfter: string | null): Date {
  const value = retryAfter?.trim() ?? "";
  if (/^\d+$/.test(value)) return new Date(now.getTime() + Number(value) * 1000);
  const date = value ? new Date(value) : undefined;
  if (date && !Number.isNaN(date.getTime())) return date > now ? date : now;
  return new Date(now.getTime() + defaultRetryAfterMs);
}

export function subscriptionRunner(context: Context): Runner {
  return {
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
      let token: string;
      try {
        if (!context.config.secretKey) throw new Error("no CRONK_SECRET_KEY");
        token = secretBox(context.config.secretKey).open(trigger.tokenSealed);
      } catch {
        return refuse({
          kind: "not_configured",
          message:
            `Cronk can't read the token of the trigger ${trigger.triggerId} for ${run.model} on ${run.runner.name}, ` +
            "as CRONK_SECRET_KEY changed or is unset: its Owner saves the trigger again.",
        });
      }

      const named = `the trigger ${trigger.triggerId} for ${run.model} on ${run.runner.name}`;
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
      const string = (value: unknown) => (typeof value === "string" ? value : undefined);
      return {
        started: true,
        reference: { sessionId: string(body.claude_code_session_id), url: string(body.claude_code_session_url) },
      };
    },
  };
}
