import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import type { Db } from "../db.js";
import { requireSecretBox } from "../encryption.js";
import { ApiError } from "../http/errors.js";
import { hashSecret, issueSecret } from "../identity/secrets.js";
import { appJwt, convertManifest, under } from "./client.js";

/**
 * The installation's one GitHub App, created through GitHub's manifest flow: Cronk hands
 * the browser a manifest to post to GitHub, GitHub creates the App and sends the browser
 * back with a code, and Cronk trades the code for the App's credentials, storing its
 * secrets encrypted. The App signs Users in, reads and writes the Repositories it's installed
 * on and sends Cronk webhooks.
 *
 * Any Admin may create it, during setup or later, but only while the installation has
 * none, so no Admin can swap the App every Workspace signs in through.
 */

/** How much a permission allows on GitHub; `write` includes reading. */
export type Access = "read" | "write";

export const GitHubApp = Type.Object({
  name: Type.String(),
  /** The GitHub account or organization the App belongs to on GitHub. */
  githubAccount: Type.String(),
  htmlUrl: Type.String({ format: "uri" }),
});
export type GitHubApp = Static<typeof GitHubApp>;

export const ManifestStart = Type.Object({
  url: Type.String({ format: "uri" }),
  manifest: Type.Record(Type.String(), Type.Unknown()),
});
export type ManifestStart = Static<typeof ManifestStart>;

/** A manifest flow must come back within an hour. */
const stateLifetimeMs = 60 * 60 * 1000;

export const callbackPath = "/api/github/callback";
export const createdPath = "/api/github/app/created";
export const webhooksPath = "/api/github/webhooks";

/**
 * What the App needs from GitHub: reading email addresses to sign Users in; reading checks
 * and commit statuses on the Repositories it's installed on; and writing their contents and
 * Pull Requests, so Runs push branches and open Pull Requests with its token and agents
 * merge through it (ADR 0007).
 */
export const requiredPermissions: Readonly<Record<string, Access>> = {
  emails: "read",
  metadata: "read",
  contents: "write",
  pull_requests: "write",
  checks: "read",
  statuses: "read",
  issues: "read",
};

/** The webhook events the App subscribes to; `repository` reports renames and transfers. */
export const requiredEvents: readonly string[] = [
  "pull_request",
  "pull_request_review",
  "check_run",
  "check_suite",
  "status",
  "repository",
];

export async function findApp(db: Db): Promise<GitHubApp | null> {
  const { rows } = await db.query<GitHubApp>(
    `select name, owner_login as "githubAccount", html_url as "htmlUrl" from github_app`,
  );
  return rows[0] ?? null;
}

export interface AppCredentials {
  clientId: string;
  clientSecret: string;
}

/** The refusal for anything that needs the GitHub App while the installation has none. */
export const githubNotSetUp = () =>
  new ApiError(409, "github_not_set_up", "This installation has no GitHub App yet. An Admin can create it on the GitHub page.");

/** The App's OAuth credentials, decrypted, or nothing if there is no App. */
export async function appCredentials({ db, config }: Context): Promise<AppCredentials | undefined> {
  const { rows } = await db.query<{ client_id: string; client_secret: string }>(
    "select client_id, client_secret from github_app",
  );
  const row = rows[0];
  if (!row) return undefined;
  return { clientId: row.client_id, clientSecret: requireSecretBox(config).open(row.client_secret) };
}

const appExists = () =>
  new ApiError(409, "github_app_exists", "This installation already has its GitHub App.");

export async function isAnyAdmin(db: Db, userId: string): Promise<boolean> {
  const { rowCount } = await db.query("select 1 from memberships where user_id = $1 and is_admin limit 1", [userId]);
  return rowCount !== 0;
}

/** Starts the manifest flow for an Admin: where to post which manifest. */
export async function startManifestFlow(
  { db, config, clock }: Context,
  userId: string,
  githubOrganization?: string,
): Promise<ManifestStart> {
  if (!(await isAnyAdmin(db, userId))) {
    throw new ApiError(403, "not_admin", "Only an Admin can create the installation's GitHub App.");
  }
  requireSecretBox(config);
  if (await findApp(db)) throw appExists();

  const state = issueSecret("github_state");
  const now = clock.now();
  await db.query("insert into github_app_states (token_hash, user_id, created_at, expires_at) values ($1, $2, $3, $4)", [
    hashSecret(state),
    userId,
    now,
    new Date(now.getTime() + stateLifetimeMs),
  ]);

  const origin = config.publicUrl.origin;
  const where = githubOrganization
    ? `/organizations/${encodeURIComponent(githubOrganization.trim())}/settings/apps/new`
    : "/settings/apps/new";
  const url = under(config.github.url, where);
  url.searchParams.set("state", state);
  return {
    url: url.toString(),
    manifest: {
      // GitHub App names are unique on GitHub and at most 34 characters; GitHub lets the Admin change it.
      name: `Cronk ${config.publicUrl.host}`.slice(0, 34),
      url: origin,
      redirect_url: `${origin}${createdPath}`,
      callback_urls: [`${origin}${callbackPath}`],
      public: false,
      request_oauth_on_install: false,
      default_permissions: { ...requiredPermissions },
      default_events: [...requiredEvents],
      // GitHub generates the webhook secret and hands it back with the App's other credentials.
      hook_attributes: { url: `${origin}${webhooksPath}`, active: true },
    },
  };
}

/**
 * Finishes the manifest flow GitHub sent the browser back from: checks the state is one an
 * Admin started and hasn't used, trades the code for the App's credentials and stores them.
 */
export async function finishManifestFlow(context: Context, code: string, state: string): Promise<GitHubApp> {
  const { db, config, clock } = context;
  const box = requireSecretBox(config);
  const now = clock.now();
  const { rows } = await db.query<{ user_id: string; live: boolean }>(
    "delete from github_app_states where token_hash = $1 returning user_id, expires_at > $2 as live",
    [hashSecret(state), now],
  );
  const started = rows[0];
  if (!started?.live || !(await isAnyAdmin(db, started.user_id))) {
    throw new ApiError(404, "invalid_state", "That GitHub App creation has expired, was used or never started.");
  }
  if (await findApp(db)) throw appExists();

  const app = await convertManifest(config, code);
  const { rowCount } = await db.query(
    `insert into github_app (app_id, slug, name, owner_login, html_url, client_id, client_secret, webhook_secret,
                             webhook_secret_confirmed_at, private_key, created_by, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, case when $8::text is null then null else $11::timestamptz end, $9, $10, $11)
     on conflict do nothing`,
    [
      app.id,
      app.slug,
      app.name,
      app.owner.login,
      app.html_url,
      app.client_id,
      box.seal(app.client_secret),
      app.webhook_secret ? box.seal(app.webhook_secret) : null,
      box.seal(app.pem),
      started.user_id,
      now,
    ],
  );
  // Another Admin's flow may have finished first.
  if (rowCount === 0) throw appExists();
  return { name: app.name, githubAccount: app.owner.login, htmlUrl: app.html_url };
}

/** A JSON web token GitHub takes as the App itself, or a refusal while the installation has no App. */
export async function appToken({ db, config, clock }: Context): Promise<string> {
  const { rows } = await db.query<{ app_id: string; private_key: string }>("select app_id, private_key from github_app");
  const row = rows[0];
  if (!row) throw githubNotSetUp();
  return appJwt({ appId: Number(row.app_id), privateKey: requireSecretBox(config).open(row.private_key) }, clock.now());
}

export interface WebhookSecret {
  secret: string;
  /** Whether GitHub is known to sign deliveries with it. */
  confirmed: boolean;
}

/** The App's webhook secret, decrypted, or nothing if there is no App or it has none. */
export async function webhookSecret({ db, config }: Context): Promise<WebhookSecret | undefined> {
  const { rows } = await db.query<{ webhook_secret: string | null; confirmed: boolean }>(
    "select webhook_secret, webhook_secret_confirmed_at is not null as confirmed from github_app",
  );
  const row = rows[0];
  if (!row?.webhook_secret) return undefined;
  return { secret: requireSecretBox(config).open(row.webhook_secret), confirmed: row.confirmed };
}
