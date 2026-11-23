import type { FastifyRequest } from "fastify";
import { authenticateAgent, ownerName } from "../agents/tokens.js";
import type { Context } from "../context.js";
import { ApiError } from "../http/errors.js";
import { requireCaller, type Caller } from "./callers.js";
import { requireUser } from "./sign-ins.js";
import type { User } from "./user.js";

/**
 * The one seam for what an Agent may do by its Token access. A User, or an Agent with a Full token, acts as an Owner:
 * the Agent-specific rules don't bind it, though Access still does. A short list of acts stays human-only whatever the
 * token: Verification (Accept and Reopen), Access and Admin settings, a Decision's status and resolving threads.
 */

/** Whether the caller acts with its Owner's rights: a User, or an Agent with a Full token. */
export const actsAsOwner = (caller: Caller): boolean => caller.kind === "user" || caller.access === "full";

/** Refuses an Agent without a Full token an act only a User or a Full token takes, with `full_token_needed`. */
export function requireOwnerAct(caller: Caller, rule: { act: string; rule: string }): void {
  if (actsAsOwner(caller) || caller.kind !== "agent") return;
  const level = caller.access === "read" ? "Read" : "Write";
  throw new ApiError(403, "full_token_needed", `${caller.name}'s token is ${level}, and ${rule.act} needs a Full token.`, {
    rule: `${rule.rule} An Agent takes this act only with a Full token, which its Owner picks by hand.`,
    advice: `Ask ${ownerName(caller)}, ${caller.name}'s Owner, to do it, or to connect you with a Full token.`,
  });
}

/** Refuses an Agent with a Full token an act that stays human-only, with `human_only`, naming the act. */
export function requireHumanAct(caller: Caller | undefined, act: string): void {
  if (caller?.kind !== "agent" || caller.access !== "full") return;
  throw new ApiError(403, "human_only", `Only a User may ${act}, even with a Full token.`, {
    rule:
      "A Full token acts with its Owner's rights, but Verification (Accept and Reopen), Access and Admin settings, a " +
      "Decision's status and resolving threads stay human-only.",
    advice: `Leave a Comment asking ${ownerName(caller)}, ${caller.name}'s Owner, to ${act}.`,
  });
}

/** The User making a request for a human-only act: an Agent with a Full token gets `human_only`, any other Agent the usual refusal. */
export async function requireHuman(context: Context, request: FastifyRequest, act: string): Promise<User> {
  requireHumanAct(await authenticateAgent(context, request), act);
  return requireUser(context, request);
}

/**
 * The caller of a request for an act a User or a Full token takes: an Agent without a Full token gets
 * `full_token_needed`, naming the rule, before anything else is read.
 */
export async function requireOwnerCaller(
  context: Context,
  request: FastifyRequest,
  rule: { act: string; rule: string },
): Promise<Caller> {
  const agent = await authenticateAgent(context, request);
  if (agent) {
    requireOwnerAct(agent, rule);
    return agent;
  }
  return requireCaller(context, request);
}
