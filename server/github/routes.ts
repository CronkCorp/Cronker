import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { ApiError, ErrorBody } from "../http/errors.js";
import { requireUser } from "../identity/sign-ins.js";
import { createdPath, findApp, finishManifestFlow, GitHubApp, ManifestStart, startManifestFlow } from "./app.js";

/** Where a browser GitHub sent back is sent on: a page of the web client, with an error code if it failed. */
function pageWith(path: string, error: unknown, fallback: string): string {
  const code = error instanceof ApiError ? error.code : fallback;
  return `${path}?error=${encodeURIComponent(code)}`;
}

export function githubRoutes(context: Context): FastifyPluginAsyncTypebox {
  const { db } = context;
  return async (app) => {
    app.get(
      "/api/github/app",
      {
        schema: {
          tags: ["GitHub"],
          summary: "The installation's GitHub App, if it has one",
          description: "Anyone may ask, so the sign-in page knows whether to offer signing in with GitHub.",
          response: { 200: Type.Object({ app: Type.Union([GitHubApp, Type.Null()]) }) },
        },
      },
      async () => ({ app: await findApp(db) }),
    );

    app.post(
      "/api/github/app/manifest",
      {
        schema: {
          tags: ["GitHub"],
          summary: "Start creating the installation's GitHub App (Admins only)",
          description:
            "Returns a manifest and the GitHub address to post it to as the form field `manifest`, from the browser. GitHub creates the App under the Admin's account (or the `organization`) and sends the browser back to Cronk, which stores the App's credentials encrypted. Refused with `github_app_exists` once the installation has its App, and with `no_secret_key` while Cronk has no `CRONK_SECRET_KEY`.",
          body: Type.Object({ organization: Type.Optional(Type.String({ minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9-]+$" })) }),
          response: { 201: ManifestStart, 401: ErrorBody, 403: ErrorBody, 409: ErrorBody },
        },
      },
      async (request, reply) => {
        const user = await requireUser(context, request);
        return reply.code(201).send(await startManifestFlow(context, user.id, request.body.organization));
      },
    );

    app.get(
      createdPath,
      {
        schema: {
          tags: ["GitHub"],
          summary: "Where GitHub sends the browser back after creating the App",
          description: "Redirects to the web client's `/github` page, with `?created=1` or `?error=<code>`.",
          querystring: Type.Object({ code: Type.Optional(Type.String()), state: Type.Optional(Type.String()) }),
          response: { 302: Type.Null() },
        },
      },
      async (request, reply) => {
        const { code, state } = request.query;
        try {
          if (!code || !state) throw new ApiError(400, "invalid_state", "GitHub sent no code or state.");
          await finishManifestFlow(context, code, state);
          return reply.redirect("/github?created=1");
        } catch (error) {
          if (!(error instanceof ApiError)) request.log.error(error);
          return reply.redirect(pageWith("/github", error, "failed"));
        }
      },
    );
  };
}
