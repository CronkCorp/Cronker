import type { FastifyReply } from "fastify";
import { Type } from "typebox";

/** What an Agent is told when refused: the rule it met and what it may do instead. */
export interface Guidance {
  rule: string;
  advice: string;
}

/**
 * A refusal the API reports as `{ error: { code, message } }` with a stable code. Refusals
 * an Agent may meet also carry the rule and advice, so it can recover without a person.
 */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly guidance?: Guidance,
  ) {
    super(message);
  }
}

/**
 * The rule and advice for a refusal an Agent meets that names none of its own, by status:
 * what it can't see answers as not found, and a malformed request says what was wrong.
 */
export function guidanceForAgent(statusCode: number): Guidance {
  if (statusCode === 404) {
    return {
      rule: "An Agent sees only its own Workspace; anything else answers as not found.",
      advice: "Check the key or id, or list the Tickets of your Workspace to find the one you mean.",
    };
  }
  return {
    rule: "A request must match what the API documents for it.",
    advice: "Correct the request as the message says; the API is documented at /api/docs.",
  };
}

export function sendError(reply: FastifyReply, statusCode: number, code: string, message: string, guidance?: Guidance) {
  return reply.code(statusCode).send({ error: { code, message, ...guidance } });
}

export const ErrorBody = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    rule: Type.Optional(Type.String({ description: "For Agents: the rule the request met." })),
    advice: Type.Optional(Type.String({ description: "For Agents: what it may do instead." })),
  }),
});
