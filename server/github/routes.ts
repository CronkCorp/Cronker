import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import type { Context } from "../context.js";
import { deliveryRoute } from "../http/deliveries.js";
import { ApiError, ErrorBody } from "../http/errors.js";
import { requireCaller } from "../identity/callers.js";
import { requireUser } from "../identity/sign-ins.js";
import { beginSignIn, finishSignIn } from "./sign-in.js";
import { beginLink, finishLink, isLinkState } from "./link.js";
import { callbackPath, createdPath, findApp, finishManifestFlow, GitHubApp, ManifestStart, startManifestFlow, webhooksPath } from "./app.js";
import { Installation, listInstallations } from "./installations.js";
import { Checklist, checklist } from "./upgrade.js";
import { addRepository, removeRepository, repositoriesOf, Repository } from "./repositories.js";
import { PullRequest, pullRequestsOf } from "./pull-requests.js";
import { receiveDelivery } from "./webhooks.js";

/** GitHub sends webhook payloads of up to 25 MB. */
const webhookBodyLimit = 25 * 1024 * 1024;

/** The page a User links their GitHub account from. */
const accountPage = "/account";

/** Where a browser GitHub sent back is sent on: a page of the web client, with an error code if it failed. */
function pageWith(path: string, error: unknown, fallback: string, parameter = "error"): string {
  const code = error instanceof ApiError ? error.code : fallback;
  return `${path}?${parameter}=${encodeURIComponent(code)}`;
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

    app.get(
      "/api/github/sign-in",
      {
        schema: {
          tags: ["GitHub"],
          summary: "Sign in with GitHub",
          description:
            "For a browser to open: redirects to GitHub to authorize the installation's GitHub App, which sends the browser back to Cronk to finish signing in. If that can't start, redirects to `/?github_error=<code>`.",
          response: { 302: Type.Null() },
        },
      },
      async (request, reply) => {
        try {
          return reply.redirect(await beginSignIn(context, reply));
        } catch (error) {
          if (!(error instanceof ApiError)) request.log.error(error);
          return reply.redirect(pageWith("/", error, "failed", "github_error"));
        }
      },
    );

    app.get(
      "/api/github/link",
      {
        schema: {
          tags: ["GitHub"],
          summary: "Link a GitHub account to the signed-in User",
          description:
            "For a signed-in User's browser to open: redirects to GitHub to authorize the installation's GitHub App, which sends the browser back to Cronk to link the GitHub account to this User. Once linked, the account signs in as the User and its merges are the User's own. Redirects to `/account?github=linked` once linked, or to `/account?github_link_error=<code>`: `github_already_linked` when the User has a GitHub account already, `github_account_taken` when another User has that account, `invalid_state` when the link didn't start in this browser or took too long, `github_denied` when GitHub didn't authorize, `github_not_set_up` while there is no App, and `not_signed_in` when nobody is signed in.",
          response: { 302: Type.Null() },
        },
      },
      async (request, reply) => {
        try {
          const user = await requireUser(context, request);
          return reply.redirect(await beginLink(context, reply, user));
        } catch (error) {
          if (!(error instanceof ApiError)) request.log.error(error);
          return reply.redirect(pageWith(accountPage, error, "failed", "github_link_error"));
        }
      },
    );

    app.get(
      callbackPath,
      {
        schema: {
          tags: ["GitHub"],
          summary: "Where GitHub sends the browser back to sign in",
          description:
            "Signs in the User the GitHub account is linked to, linking it first to the User with its verified primary email if it isn't linked yet. Redirects to `/`, or to `/?github_error=<code>`: `unknown_github_user` when no User has the account, `invalid_state` when the sign-in didn't start in this browser, `github_denied` when GitHub didn't sign the User in. A link started at `GET /api/github/link` finishes here too, and redirects as that says.",
          querystring: Type.Object({
            code: Type.Optional(Type.String()),
            state: Type.Optional(Type.String()),
            error: Type.Optional(Type.String()),
          }),
          response: { 302: Type.Null() },
        },
      },
      async (request, reply) => {
        if (isLinkState(request.query.state)) {
          try {
            await finishLink(context, request, reply, request.query);
            return reply.redirect(`${accountPage}?github=linked`);
          } catch (error) {
            if (!(error instanceof ApiError)) request.log.error(error);
            return reply.redirect(pageWith(accountPage, error, "failed", "github_link_error"));
          }
        }
        try {
          await finishSignIn(context, request, reply, request.query);
          return reply.redirect("/");
        } catch (error) {
          if (!(error instanceof ApiError)) request.log.error(error);
          return reply.redirect(pageWith("/", error, "failed", "github_error"));
        }
      },
    );

    app.post(
      "/api/github/app/manifest",
      {
        schema: {
          tags: ["GitHub"],
          summary: "Start creating the installation's GitHub App (Admins only)",
          description:
            "Returns a manifest and the GitHub address to post it to as the form field `manifest`, from the browser. GitHub creates the App under the Admin's GitHub account (or the `githubOrganization`) and sends the browser back to Cronk, which stores the App's credentials encrypted. Refused with `github_app_exists` once the installation has its App, and with `no_secret_key` while Cronk has no `CRONK_SECRET_KEY`.",
          body: Type.Object({ githubOrganization: Type.Optional(Type.String({ minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9-]+$" })) }),
          response: { 201: ManifestStart, 401: ErrorBody, 403: ErrorBody, 409: ErrorBody },
        },
      },
      async (request, reply) => {
        const user = await requireUser(context, request);
        return reply.code(201).send(await startManifestFlow(context, user.id, request.body.githubOrganization));
      },
    );

    app.get(
      "/api/github/app/checklist",
      {
        schema: {
          tags: ["GitHub"],
          summary: "What the GitHub App still lacks (Admins only)",
          description:
            "Asks GitHub, as the App, what it has, and lists what it lacks of what Cronk needs: permissions, events, and the webhook URL and secret to paste into the App's settings on GitHub (`settingsUrl`), which the manifest flow can't change for an existing App. Also lists the App's installations whose owner hasn't accepted the permissions they lack. Refused with `github_not_set_up` while there is no App, and with `github_unavailable` if GitHub can't be asked.",
          response: { 200: Checklist, 401: ErrorBody, 403: ErrorBody, 409: ErrorBody, 502: ErrorBody },
        },
      },
      async (request) => checklist(context, (await requireUser(context, request)).id),
    );

    app.get(
      "/api/github/installations",
      {
        schema: {
          tags: ["GitHub"],
          summary: "The GitHub App's installations and the Repositories each covers",
          description:
            "Every GitHub account or organization the App is installed on, with the Repositories it covers there, by account and then by `owner/name`, ignoring case. Installing the App on GitHub is what makes a Repository available to Cronk. Cronk keeps what GitHub said for five minutes per installation, and forgets it sooner when it learns it changed, such as a Repository added to or removed from a Project or renamed or transferred on GitHub; `refresh=true` asks GitHub afresh, as for a Repository just installed there. Refused with `github_not_set_up` while there is no App, and with `github_unavailable` if GitHub can't be asked.",
          querystring: Type.Object({
            refresh: Type.Optional(Type.Boolean({ description: "Ask GitHub afresh instead of using the list Cronk keeps." })),
          }),
          response: { 200: Type.Array(Installation), 401: ErrorBody, 403: ErrorBody, 409: ErrorBody, 502: ErrorBody },
        },
      },
      async (request) => {
        await requireUser(context, request);
        return listInstallations(context, { refresh: request.query.refresh === true });
      },
    );

    app.get(
      "/api/projects/:projectId/repositories",
      {
        schema: {
          tags: ["GitHub"],
          summary: "The Repositories a Project lists as holding its code",
          description: "Each by GitHub's id, with its owner and name as GitHub last reported them, which follow renames and transfers.",
          params: Type.Object({ projectId: Type.String() }),
          response: { 200: Type.Array(Repository), 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => repositoriesOf(context, await requireCaller(context, request), request.params.projectId),
    );

    app.post(
      "/api/projects/:projectId/repositories",
      {
        schema: {
          tags: ["GitHub"],
          summary: "Add a Repository to a Project (Users only)",
          description:
            "Adds a Repository one of the GitHub App's installations covers (see `GET /api/github/installations`), by GitHub's id. Refused with `repository_not_installed` if no installation covers it, `repository_already_listed` if the Project lists it already, `github_not_set_up` while there is no App, and `github_unavailable` if GitHub can't be asked.",
          params: Type.Object({ projectId: Type.String() }),
          body: Type.Object({ id: Type.Integer({ minimum: 1, description: "GitHub's id for the Repository." }) }),
          response: { 201: Repository, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody, 502: ErrorBody },
        },
      },
      async (request, reply) => {
        const user = await requireUser(context, request);
        return reply.code(201).send(await addRepository(context, user.id, request.params.projectId, request.body.id));
      },
    );

    app.delete(
      "/api/projects/:projectId/repositories/:repositoryId",
      {
        schema: {
          tags: ["GitHub"],
          summary: "Remove a Repository from a Project (Users only)",
          description: "Its Pull Requests stop linking to the Project's Tickets. Answers 404 if the Project doesn't list it.",
          params: Type.Object({ projectId: Type.String(), repositoryId: Type.Integer({ minimum: 1 }) }),
          response: { 204: Type.Null(), 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
        },
      },
      async (request, reply) => {
        const user = await requireUser(context, request);
        await removeRepository(context, user.id, request.params.projectId, request.params.repositoryId);
        return reply.code(204).send(null);
      },
    );

    app.get(
      "/api/tickets/:ticketId/pull-requests",
      {
        schema: {
          tags: ["Tickets"],
          summary: "A Ticket's Pull Requests",
          description:
            "Pull Requests of the Repositories its Project lists whose branch or title names the Ticket's key, oldest link first, each with its state, the checks on its latest commit and its producing Step.",
          params: Type.Object({ ticketId: Type.String() }),
          response: { 200: Type.Array(PullRequest), 401: ErrorBody, 404: ErrorBody },
        },
      },
      async (request) => pullRequestsOf(db, await requireCaller(context, request), request.params.ticketId),
    );

    await deliveryRoute(
      app,
      webhooksPath,
      {
        bodyLimit: webhookBodyLimit,
        schema: {
          tags: ["GitHub"],
          summary: "Where GitHub sends the App's webhook deliveries",
          description:
            "For GitHub only. A delivery must carry `X-Hub-Signature-256`, the HMAC-SHA256 of its body under the App's webhook secret, or it is refused with `invalid_signature` before anything else is looked at. Each delivery is applied once, by its `X-GitHub-Delivery` id: `applied` says whether this call applied it, and is false for one applied before.",
          response: { 200: Type.Object({ applied: Type.Boolean() }), 400: ErrorBody, 401: ErrorBody },
        },
      },
      async ({ body, header }) => {
        const applied = await receiveDelivery(context, body, {
          signature: header("x-hub-signature-256"),
          event: header("x-github-event"),
          id: header("x-github-delivery"),
          contentType: header("content-type"),
        });
        return { applied };
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
