import { randomBytes } from "node:crypto";
import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { requireSecretBox } from "../encryption.js";
import { ApiError } from "../http/errors.js";
import { githubNotSetUp, isAnyAdmin, requiredEvents, requiredPermissions, webhooksPath } from "./app.js";
import { appInstallations, appJwt, appOnGitHub, appWebhook, under, type AppKey } from "./client.js";

/**
 * The checklist for upgrading an App GitHub's manifest flow can't change, such as one created
 * for sign-in only: Cronk asks GitHub, as the App, what it has, and lists what it still lacks
 * for the Admin to add in the App's settings on GitHub. Installations keep the permissions
 * their owner accepted until the owner accepts the new ones, so those are listed too.
 */

const Permissions = Type.Record(Type.String(), Type.String(), {
  description: "Permissions by name, each with the access needed (always `read`).",
});

export const Checklist = Type.Object({
  /** The App's settings page on GitHub, where its permissions, events and webhook are edited. */
  settingsUrl: Type.String({ format: "uri" }),
  missingPermissions: Permissions,
  missingEvents: Type.Array(Type.String()),
  webhook: Type.Union([Type.Object({ url: Type.String({ format: "uri" }), secret: Type.String() }), Type.Null()], {
    description: "The webhook URL and secret to paste into the App's settings, or null when GitHub already sends deliveries to Cronk, signed.",
  }),
  installationsNotAccepted: Type.Array(
    Type.Object({ account: Type.String(), htmlUrl: Type.String({ format: "uri" }), missingPermissions: Permissions }),
  ),
});
export type Checklist = Static<typeof Checklist>;

/** Permissions an installation has accepted for itself; `emails` belongs to each User's sign-in instead. */
const installationPermissions = Object.keys(requiredPermissions).filter((name) => name !== "emails");

function missingOf(has: Record<string, string> | undefined, names: string[]): Record<string, string> {
  const missing: Record<string, string> = {};
  // Any access, such as `write` granted by hand, includes reading.
  for (const name of names) if (!has?.[name] || has[name] === "none") missing[name] = requiredPermissions[name]!;
  return missing;
}

/** The App's id and private key, decrypted, or a refusal while the installation has no App. */
export async function appKey({ db, config }: Context): Promise<AppKey> {
  const { rows } = await db.query<{ app_id: string; private_key: string }>("select app_id, private_key from github_app");
  const row = rows[0];
  if (!row) throw githubNotSetUp();
  return { appId: Number(row.app_id), privateKey: requireSecretBox(config).open(row.private_key) };
}

/** Cronk's webhook secret for the App, made now if the App was created without one. */
async function webhookSecret({ db, config }: Context): Promise<string> {
  const box = requireSecretBox(config);
  const made = box.seal(randomBytes(32).toString("hex"));
  // Only the first of two Admins looking at once stores theirs; both then read the same one.
  await db.query("update github_app set webhook_secret = $1 where webhook_secret is null", [made]);
  const { rows } = await db.query<{ webhook_secret: string }>("select webhook_secret from github_app");
  return box.open(rows[0]!.webhook_secret);
}

export async function checklist(context: Context, userId: string): Promise<Checklist> {
  const { config, clock } = context;
  if (!(await isAnyAdmin(context.db, userId))) {
    throw new ApiError(403, "not_admin", "Only an Admin can see what the GitHub App lacks, since that includes its webhook secret.");
  }
  const jwt = appJwt(await appKey(context), clock.now());
  const [app, hook, installations] = await Promise.all([
    appOnGitHub(config, jwt),
    appWebhook(config, jwt),
    appInstallations(config, jwt),
  ]);
  const url = `${config.publicUrl.origin}${webhooksPath}`;
  const settingsPath =
    app.owner.type === "Organization"
      ? `/organizations/${encodeURIComponent(app.owner.login)}/settings/apps/${encodeURIComponent(app.slug)}`
      : `/settings/apps/${encodeURIComponent(app.slug)}`;
  return {
    settingsUrl: under(config.github.url, settingsPath).toString(),
    missingPermissions: missingOf(app.permissions, Object.keys(requiredPermissions)),
    missingEvents: requiredEvents.filter((event) => !app.events?.includes(event)),
    webhook: hook?.url === url && hook.hasSecret ? null : { url, secret: await webhookSecret(context) },
    installationsNotAccepted: installations
      .map((i) => ({ account: i.account.login, htmlUrl: i.html_url, missingPermissions: missingOf(i.permissions, installationPermissions) }))
      .filter((i) => Object.keys(i.missingPermissions).length > 0),
  };
}
