import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { ErrorBody } from "../http/errors.js";
import { requireCaller } from "../identity/callers.js";
import {
  compareDecisionVersions,
  createDecision,
  Decision,
  DecisionCreate,
  DecisionEdit,
  DecisionComparison,
  decisionNotFound,
  decisionsOf,
  DecisionSummary,
  DecisionVersion,
  DecisionVersionWithBody,
  decisionVersionsOf,
  deleteDecision,
  editDecision,
  findDecision,
  readDecisionVersion,
} from "./decisions.js";
import { knowledgePlaces } from "./places.js";
import { OutdatedVersionBody } from "./versions.js";

const tags = ["Decisions"];
const DecisionParams = Type.Object({ decisionId: Type.String() });
const VersionNumber = Type.Integer({ minimum: 1 });
const statusRules =
  "Only a User changes a Decision's status; an Agent's change is refused with `agent_not_allowed`. Superseded needs " +
  "`supersededById`, another Decision of the same Project, or of the Workspace for one of the Workspace's " +
  "(`superseding_decision_needed`, `superseding_decision_outside_scope`); other statuses take none.";

export function decisionRoutes(context: Context): FastifyPluginAsyncTypebox {
  const { db } = context;

  return async (app) => {
    for (const place of knowledgePlaces(db)) {
      const { params } = place;
      const path = `${place.path}/decisions`;

      app.get(
        path,
        {
          schema: {
            tags,
            summary: `${place.name[0]!.toUpperCase()}${place.name.slice(1)} Decisions`,
            description:
              "Its Decisions by number, without their bodies. A Project's Decisions and the Workspace's own are separate.",
            params,
            response: { 200: Type.Array(DecisionSummary), 401: ErrorBody, 404: ErrorBody },
          },
        },
        async (request) => decisionsOf(db, await place.find(request, await requireCaller(context, request))),
      );

      app.post(
        path,
        {
          schema: {
            tags,
            summary: `Record one of ${place.name} Decisions`,
            description:
              "Records the Decision numbered next in order of creation, at Version 1 by its Actor, as proposed unless " +
              `a status is given. ${statusRules}`,
            params,
            body: DecisionCreate,
            response: { 201: Decision, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody },
          },
        },
        async (request, reply) => {
          const caller = await requireCaller(context, request);
          const { body = "", ...input } = request.body;
          const created = await createDecision(context, caller, await place.find(request, caller), { ...input, body });
          return reply.code(201).send(created);
        },
      );
    }

    app.get(
      "/api/decisions/:decisionId",
      {
        schema: {
          tags,
          summary: "A Decision at its current Version",
          params: DecisionParams,
          response: { 200: Decision, 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => {
        const caller = await requireCaller(context, request);
        const decision = await findDecision(db, caller, request.params.decisionId);
        if (!decision) throw decisionNotFound();
        return decision;
      },
    );

    app.patch(
      "/api/decisions/:decisionId",
      {
        schema: {
          tags,
          summary: "Save a Decision",
          description:
            "Saves a new title, body or status as the Decision's next Version, by the caller, based on the Version named " +
            "as `baseVersion`. A save based on an outdated Version is refused with `outdated_version`, carrying the " +
            `current Version as \`current\`. Accepted Decisions stay editable. ${statusRules}`,
          params: DecisionParams,
          body: DecisionEdit,
          response: { 200: Decision, 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: OutdatedVersionBody("Decision", DecisionVersionWithBody) },
        },
      },
      async (request) => editDecision(context, await requireCaller(context, request), request.params.decisionId, request.body),
    );

    app.delete(
      "/api/decisions/:decisionId",
      {
        schema: {
          tags,
          summary: "Decisions are never deleted",
          description:
            "Always refused with `decision_not_deletable`, so a Decision's history stays: a User marks it rejected, " +
            "deprecated or superseded instead.",
          params: DecisionParams,
          response: { 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 405: ErrorBody },
        },
      },
      async (request) => deleteDecision(db, await requireCaller(context, request), request.params.decisionId),
    );

    app.get(
      "/api/decisions/:decisionId/versions",
      {
        schema: {
          tags,
          summary: "A Decision's Versions, oldest first",
          description: "Each Version's number, title, status, Actor and time, without its body; read one for its body.",
          params: DecisionParams,
          response: { 200: Type.Array(DecisionVersion), 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => decisionVersionsOf(db, await requireCaller(context, request), request.params.decisionId),
    );

    app.get(
      "/api/decisions/:decisionId/versions/compare",
      {
        schema: {
          tags,
          summary: "Compare two of a Decision's Versions",
          description: "Both Versions, and their bodies compared line by line from `from` to `to`.",
          params: DecisionParams,
          querystring: Type.Object({ from: VersionNumber, to: VersionNumber }),
          response: { 200: DecisionComparison, 400: ErrorBody, 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) =>
        compareDecisionVersions(db, await requireCaller(context, request), request.params.decisionId, request.query),
    );

    app.get(
      "/api/decisions/:decisionId/versions/:number",
      {
        schema: {
          tags,
          summary: "One of a Decision's Versions, with its body",
          params: Type.Object({ decisionId: Type.String(), number: VersionNumber }),
          response: { 200: DecisionVersionWithBody, 400: ErrorBody, 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) =>
        readDecisionVersion(db, await requireCaller(context, request), request.params.decisionId, request.params.number),
    );
  };
}
