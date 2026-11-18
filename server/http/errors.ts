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
