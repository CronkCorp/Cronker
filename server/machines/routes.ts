import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { ErrorBody } from "../http/errors.js";
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

export function machineRoutes(context: Context): FastifyPluginAsyncTypebox {
  return async (app) => {
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
  };
}
