import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { ApiError, ErrorBody } from "../http/errors.js";
import { requireUser } from "../identity/sign-ins.js";
import {
  approvePairing,
  Machine,
  MachineSelf,
  machinesOf,
  PairedMachine,
  PairingApproval,
  PairingPoll,
  PairingStart,
  pollPairing,
  requireMachine,
  startPairing,
  StartedPairing,
  unpairMachine,
} from "./machines.js";
import {
  claimableRuns,
  claimRun,
  ClaimedRun,
  heartbeat,
  LocalRunEnd,
  LocalSession,
  reportEnd,
  reportSession,
  uploadRunTranscript,
} from "./local-runs.js";
import { Transcript, TranscriptUpload } from "../transcripts/transcripts.js";
import { uploadLimitBytes } from "../transcripts/routes.js";
import { machineEventTypes, type MachineEvent } from "../live/live.js";

/** Comments keep an idle stream open through proxies that close quiet connections. */
const keepAliveMs = 25_000;

const machineEventList = Object.entries(machineEventTypes)
  .map(([type, meaning]) => `- \`${type}\`: ${meaning}`)
  .join("\n");

export function machineRoutes(context: Context): FastifyPluginAsyncTypebox {
  return async (app) => {
    // A Run's transcript arrives as the file it is: JSON Lines, read as text.
    app.addContentTypeParser("application/x-ndjson", { parseAs: "string", bodyLimit: uploadLimitBytes }, (_request, body, done) =>
      done(null, body),
    );

    app.post(
      "/api/machines/pairings",
      {
        schema: {
          tags: ["Machines"],
          summary: "Ask for a pairing code, as a Machine's daemon",
          description:
            "Called by `cronk-runner login`, without credentials. Answers a device code for the daemon to poll with and a " +
            "short user code its User approves on the Runners page. Both work for ten minutes.",
          security: [],
          body: PairingStart,
          response: { 201: StartedPairing, 400: ErrorBody },
        },
      },
      async (request, reply) => reply.code(201).send(await startPairing(context, request.body)),
    );

    app.post(
      "/api/machines/pairings/poll",
      {
        schema: {
          tags: ["Machines"],
          summary: "Poll a pairing for its Machine token, as a Machine's daemon",
          description:
            "Refused with `pairing_pending` until the User approves the code. Once approved, answers the Machine token, " +
            "this once. A pairing that expired or was already redeemed is refused with `pairing_expired`.",
          security: [],
          body: PairingPoll,
          response: { 200: PairedMachine, 400: ErrorBody, 409: ErrorBody, 410: ErrorBody },
        },
      },
      async (request) => pollPairing(context, request.body.deviceCode),
    );

    app.post(
      "/api/machines/pairings/approve",
      {
        schema: {
          tags: ["Machines"],
          summary: "Approve a pairing code, pairing a Machine with you",
          description:
            "Pairs the Machine waiting with the code to you, serving the `local` Runners you pick. Refused with " +
            "`pairing_not_found` for a code that expired, was already approved or never existed, as not found for a " +
            "Runner that isn't yours and with `runner_not_local` for a Runner of another kind.",
          body: PairingApproval,
          response: { 201: Machine, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request, reply) => {
        const user = await requireUser(context, request);
        return reply.code(201).send(await approvePairing(context, user.id, request.body));
      },
    );

    app.get(
      "/api/machines",
      {
        schema: {
          tags: ["Machines"],
          summary: "Your paired Machines",
          response: { 200: Type.Array(Machine), 401: ErrorBody, 403: ErrorBody },
        },
      },
      async (request) => machinesOf(context, (await requireUser(context, request)).id),
    );

    app.delete(
      "/api/machines/:machineId",
      {
        schema: {
          tags: ["Machines"],
          summary: "Unpair your Machine",
          description: "Revokes its Machine token, so its daemon's later calls are refused with `invalid_machine_token`.",
          params: Type.Object({ machineId: Type.String() }),
          response: { 204: Type.Null(), 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
        },
      },
      async (request, reply) => {
        const user = await requireUser(context, request);
        await unpairMachine(context, user.id, request.params.machineId);
        return reply.code(204).send(null);
      },
    );

    app.get(
      "/api/machine",
      {
        schema: {
          tags: ["Machines"],
          summary: "The Machine a Machine token belongs to",
          description:
            "Called by a Machine's daemon with its Machine token: the Machine, its User and the Runners it serves. " +
            "Records the Machine's last contact. Refused with `invalid_machine_token` once it is unpaired.",
          security: [{ machineToken: [] }],
          response: { 200: MachineSelf, 401: ErrorBody },
        },
      },
      async (request) => requireMachine(context, request),
    );

    app.get(
      "/api/machine/events",
      {
        schema: {
          tags: ["Machines"],
          summary: "The Machine's event stream",
          description:
            "A `text/event-stream` of server-sent events for a Machine's daemon, with its Machine token. On connecting it " +
            "first tells of every Run of the Runners the Machine serves that waits to be claimed, then of each one as it " +
            "starts. The event's data is JSON naming the Run by `runId`. The stream ends when the Machine is unpaired.\n\n" +
            machineEventList,
          security: [{ machineToken: [] }],
          produces: ["text/event-stream"],
          response: { 200: Type.String({ description: "The event stream." }), 401: ErrorBody, 503: ErrorBody },
        },
      },
      async (request, reply) => {
        const machine = await requireMachine(context, request);
        if (context.live.closed) throw new ApiError(503, "closing", "Cronk is shutting down; connect again shortly.");
        const raw = reply.raw;
        let open = true;
        const write = (chunk: string) => {
          if (open) raw.write(chunk);
        };
        const send = ({ type, ...data }: MachineEvent) => write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
        const close = () => {
          if (!open) return;
          open = false;
          clearInterval(keepAlive);
          unsubscribe();
          raw.end();
        };
        reply.hijack();
        raw.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        raw.write(": connected\n\n");
        // Subscribed before the replay, so a Run starting meanwhile is told at least once; a second claim is refused.
        const unsubscribe = context.live.subscribeMachine({
          machineId: machine.id,
          runnerIds: new Set(machine.runners.map((r) => r.id)),
          send,
          end: close,
        });
        const keepAlive = setInterval(() => write(": keep-alive\n\n"), keepAliveMs);
        keepAlive.unref();
        raw.on("close", close);
        for (const runId of await claimableRuns(context, machine)) send({ type: "run.claimable", runId });
        if (request.socket.destroyed) close();
      },
    );

    const runParams = Type.Object({ runId: Type.String() });

    app.post(
      "/api/machine/runs/:runId/claim",
      {
        schema: {
          tags: ["Machines"],
          summary: "Claim a Run, as a Machine's daemon",
          description:
            "Claims a Run of a Runner the Machine serves, answering what the daemon needs to run `claude`: the Brief, the " +
            "model id, an Agent token minted for the Run (revoked once the Run ends) and Cronk's MCP URL. A Run is granted " +
            "once: a Run claimed already or no longer running is refused with `run_not_claimable`, and a Machine running " +
            "as many Runs as its limit with `machine_limit_reached`. A Run whose model label lost its model id fails, " +
            "refused with `no_model_id`.",
          security: [{ machineToken: [] }],
          params: runParams,
          response: { 200: ClaimedRun, 401: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request) => claimRun(context, await requireMachine(context, request), request.params.runId),
    );

    app.post(
      "/api/machine/runs/:runId/heartbeat",
      {
        schema: {
          tags: ["Machines"],
          summary: "Heartbeat a claimed Run, as a Machine's daemon",
          description:
            "Counts as a call naming the Run, so a working Run isn't lost. Refused with `run_stopped` once the Run no " +
            "longer runs in Cronk: the daemon then kills its process.",
          security: [{ machineToken: [] }],
          params: runParams,
          response: { 204: Type.Null(), 401: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request, reply) => {
        await heartbeat(context, await requireMachine(context, request), request.params.runId);
        return reply.code(204).send(null);
      },
    );

    app.post(
      "/api/machine/runs/:runId/session",
      {
        schema: {
          tags: ["Machines"],
          summary: "Report a claimed Run's Claude Code session, as a Machine's daemon",
          description: "Records the session id as the Run's session reference. Refused with `run_stopped` once the Run no longer runs.",
          security: [{ machineToken: [] }],
          params: runParams,
          body: LocalSession,
          response: { 204: Type.Null(), 400: ErrorBody, 401: ErrorBody, 404: ErrorBody, 409: ErrorBody },
        },
      },
      async (request, reply) => {
        await reportSession(context, await requireMachine(context, request), request.params.runId, request.body.sessionId);
        return reply.code(204).send(null);
      },
    );

    app.post(
      "/api/machine/runs/:runId/end",
      {
        schema: {
          tags: ["Machines"],
          summary: "Report that a claimed Run's process ended, as a Machine's daemon",
          description:
            "A Run whose agent didn't call `finish` fails with the reason given. A Run that ended already, as `finish` " +
            "ends it, is left as it is. A `costUsd` given is recorded as the Run's cost, marked as an estimate.",
          security: [{ machineToken: [] }],
          params: runParams,
          body: LocalRunEnd,
          response: { 204: Type.Null(), 400: ErrorBody, 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request, reply) => {
        await reportEnd(context, await requireMachine(context, request), request.params.runId, request.body);
        return reply.code(204).send(null);
      },
    );

    app.put(
      "/api/machine/runs/:runId/transcript",
      {
        bodyLimit: uploadLimitBytes,
        schema: {
          tags: ["Machines"],
          summary: "Upload a claimed Run's transcript, as a Machine's daemon",
          description:
            "The daemon uploads the Run's whole Claude Code transcript, the JSONL file as it is " +
            "(`content-type: application/x-ndjson`, up to 256 MB), as the Run goes and once more after its process " +
            "ends. Like the Transcript hook's upload (`PUT /api/transcripts/sessions/{sessionId}`), it replaces what " +
            "Cronk held for the Run's session, by the Run's Agent, but takes the Machine token, so it works after the " +
            "Run ended and its own token was revoked. Answers 201 for a new Transcript and 200 for a replaced one; " +
            "refused with `no_session` before the Run's session was reported and with 410 `transcript_deleted` once a " +
            "User deleted its Transcript.",
          security: [{ machineToken: [] }],
          params: runParams,
          body: TranscriptUpload,
          response: { 200: Transcript, 201: Transcript, 400: ErrorBody, 401: ErrorBody, 404: ErrorBody, 409: ErrorBody, 410: ErrorBody, 413: ErrorBody },
        },
      },
      async (request, reply) => {
        const machine = await requireMachine(context, request);
        const { transcript, created } = await uploadRunTranscript(context, machine, request.params.runId, request.body);
        return reply.code(created ? 201 : 200).send(transcript);
      },
    );
  };
}
