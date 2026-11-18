import type { FastifyReply } from "fastify";
import { Type } from "typebox";

/** A refusal the API reports as `{ error: { code, message } }` with a stable code. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function sendError(reply: FastifyReply, statusCode: number, code: string, message: string) {
  return reply.code(statusCode).send({ error: { code, message } });
}

export const ErrorBody = Type.Object({
  error: Type.Object({ code: Type.String(), message: Type.String() }),
});
