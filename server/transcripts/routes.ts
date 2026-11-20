import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { Type } from "typebox";
import { authenticateAgent, type AgentCaller } from "../agents/tokens.js";
import type { Context } from "../context.js";
import { ApiError, ErrorBody } from "../http/errors.js";
import { requireCaller } from "../identity/callers.js";
import { requireUser } from "../identity/sign-ins.js";
import { convertClaudeCode } from "./claude-code.js";
import { hookScriptPath, readHookScript, TranscriptHook, transcriptHook } from "./hook.js";
import { entriesOf, EntryPage, findTranscript, Transcript, uploadTranscript } from "./transcripts.js";

/** The largest upload Cronk reads; what it keeps of one is capped further (ADR 0006). */
const uploadLimitBytes = 256 * 1024 * 1024;

/** The Agent whose token the request carries; a User, or a request with no token, is refused. */
async function requireAgent(context: Context, request: FastifyRequest): Promise<AgentCaller> {
  const agent = await authenticateAgent(context, request);
  if (agent) return agent;
  throw new ApiError(401, "agent_token_required", "Only an Agent uploads Transcripts, with one of its tokens.");
}

export function transcriptRoutes(context: Context): FastifyPluginAsyncTypebox {
  return async (app) => {
    // A transcript arrives as the file it is: JSON Lines, read as text.
    app.addContentTypeParser(
      ["application/x-ndjson", "application/jsonl", "application/json-lines", "text/plain", "application/octet-stream"],
      { parseAs: "string", bodyLimit: uploadLimitBytes },
      (_request, body, done) => done(null, body),
    );

    app.put(
      "/api/transcripts/sessions/:sessionId",
      {
        bodyLimit: uploadLimitBytes,
        schema: {
          tags: ["Transcripts"],
          summary: "Upload the transcript of a session",
          description:
            "An Agent uploads the whole Claude Code transcript of one of its sessions, the JSONL file as it is " +
            "(`content-type: application/x-ndjson`, up to 256 MB). Cronk converts it into entries and replaces " +
            "whatever it held for that session of the Agent. Answers 201 for a new Transcript, 200 for a replaced one.",
          params: Type.Object({ sessionId: Type.String({ minLength: 1, maxLength: 200 }) }),
          body: Type.String(),
          response: { 200: Transcript, 201: Transcript, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 413: ErrorBody },
        },
      },
      async (request, reply) => {
        const agent = await requireAgent(context, request);
        const { transcript, created } = await uploadTranscript(
          context,
          agent,
          request.params.sessionId,
          convertClaudeCode(request.body),
        );
        return reply.code(created ? 201 : 200).send(transcript);
      },
    );

    app.get(hookScriptPath, { schema: { hide: true } }, async (_request, reply) =>
      reply.type("text/javascript; charset=utf-8").header("cache-control", "no-cache").send(await readHookScript()),
    );

    app.get(
      "/api/transcript-hook",
      {
        schema: {
          tags: ["Transcripts"],
          summary: "How to install the Transcript hook",
          description:
            "The `settings.json` snippet to commit in each Repository, with this Cronk's address in it, and the " +
            "variable of the cloud environment that holds a *Transcript hook* Agent token.",
          response: { 200: TranscriptHook, 401: ErrorBody, 403: ErrorBody },
        },
      },
      async (request) => {
        await requireUser(context, request);
        return transcriptHook(context.config.publicUrl);
      },
    );

    app.post(
      "/api/transcripts/sessions/:sessionId/alive",
      {
        schema: {
          tags: ["Transcripts"],
          summary: "Say a session is still working",
          description:
            "The Transcript hook calls this during a long turn, at most once every 5 minutes, without uploading. " +
            "Like an upload, it counts as a call naming the Run whose Runner returned this session, keeping that " +
            "Run from becoming lost.",
          params: Type.Object({ sessionId: Type.String({ minLength: 1, maxLength: 200 }) }),
          response: { 204: Type.Null(), 401: ErrorBody, 403: ErrorBody },
        },
      },
      async (request, reply) => {
        await requireAgent(context, request);
        return reply.code(204).send(null);
      },
    );

    const TranscriptParams = Type.Object({ transcriptId: Type.String() });

    app.get(
      "/api/transcripts/:transcriptId",
      {
        schema: {
          tags: ["Transcripts"],
          summary: "A Transcript",
          params: TranscriptParams,
          response: { 200: Transcript, 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => findTranscript(context, await requireCaller(context, request), request.params.transcriptId),
    );

    app.get(
      "/api/transcripts/:transcriptId/entries",
      {
        schema: {
          tags: ["Transcripts"],
          summary: "A Transcript's entries",
          description: "In order, a page at a time: pass the page's `next` as `after` for the next one.",
          params: TranscriptParams,
          querystring: Type.Object({
            after: Type.Optional(Type.Integer({ minimum: 0, description: "The position to read after." })),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, default: 200 })),
          }),
          response: { 200: EntryPage, 400: ErrorBody, 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) =>
        entriesOf(context, await requireCaller(context, request), request.params.transcriptId, request.query),
    );
  };
}
